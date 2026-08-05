import { z } from 'zod';

import { ToolExecutionError, type Tool } from './types.ts';

/**
 * Arithmetic for the agent, evaluated by a tokenizer and a shunting-yard parser.
 *
 * NEVER use `eval`, `new Function`, or `node:vm` here. The expression is written
 * by a language model, which can be steered by any web page the agent has just
 * read — so it is attacker-influenced input. Any of those three would turn a
 * calculator into remote code execution on the server. A sandbox is not a fix
 * either: `vm` is not a security boundary. Parsing is, because a parser can only
 * ever produce a number.
 */

const InputSchema = z.object({
  expression: z
    .string()
    .min(1)
    .max(200)
    .describe('An arithmetic expression, e.g. "(1250 * 1.08) ^ 2 / 3".'),
});

const OutputSchema = z.object({
  value: z.number(),
  /** The expression as the parser understood it — the model can check itself against this. */
  normalizedExpression: z.string(),
});

export function createCalculatorTool(): Tool<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>
> {
  return {
    name: 'calculator',
    description:
      'Evaluate an arithmetic expression. Supports + - * / % ^ parentheses and unary minus. ' +
      'Use this instead of doing arithmetic yourself.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    timeoutMs: 1_000,
    execute: ({ expression }) => {
      const tokens = tokenize(expression);
      const rpn = toReversePolish(tokens);
      return Promise.resolve({
        value: evaluate(rpn),
        normalizedExpression: rpn.map(render).join(' '),
      });
    },
  };
}

type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'operator'; readonly symbol: OperatorSymbol }
  | { readonly kind: 'paren'; readonly symbol: '(' | ')' };

type OperatorSymbol = '+' | '-' | '*' | '/' | '%' | '^' | 'neg';

interface Operator {
  readonly precedence: number;
  readonly associativity: 'left' | 'right';
  readonly arity: 1 | 2;
}

const OPERATORS: Record<OperatorSymbol, Operator> = {
  '+': { precedence: 1, associativity: 'left', arity: 2 },
  '-': { precedence: 1, associativity: 'left', arity: 2 },
  '*': { precedence: 2, associativity: 'left', arity: 2 },
  '/': { precedence: 2, associativity: 'left', arity: 2 },
  '%': { precedence: 2, associativity: 'left', arity: 2 },
  // Exponentiation binds tighter than unary minus and associates rightwards, so
  // -2 ^ 2 is -(2 ^ 2) and 2 ^ 3 ^ 2 is 2 ^ (3 ^ 2).
  neg: { precedence: 3, associativity: 'right', arity: 1 },
  '^': { precedence: 4, associativity: 'right', arity: 2 },
};

const NUMBER = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u;

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let rest = input.trim();

  while (rest.length > 0) {
    const char = rest[0] ?? '';

    if (char === ' ' || char === '\t') {
      rest = rest.slice(1);
      continue;
    }

    const number = NUMBER.exec(rest);
    if (number !== null) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      rest = rest.slice(number[0].length);
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ kind: 'paren', symbol: char });
      rest = rest.slice(1);
      continue;
    }

    if (isBinarySymbol(char)) {
      // A minus is unary when nothing that could be a left operand precedes it.
      const previous = tokens.at(-1);
      const unary =
        char === '-' &&
        (previous === undefined ||
          previous.kind === 'operator' ||
          (previous.kind === 'paren' && previous.symbol === '('));
      tokens.push({ kind: 'operator', symbol: unary ? 'neg' : char });
      rest = rest.slice(1);
      continue;
    }

    throw new ToolExecutionError(
      `Unexpected character "${char}" in expression. Only numbers, + - * / % ^ and parentheses are allowed.`,
    );
  }

  if (tokens.length === 0) throw new ToolExecutionError('Expression is empty.');
  return tokens;
}

function isBinarySymbol(char: string): char is '+' | '-' | '*' | '/' | '%' | '^' {
  return (
    char === '+' || char === '-' || char === '*' || char === '/' || char === '%' || char === '^'
  );
}

/** Shunting-yard: infix tokens in, postfix out, precedence and associativity respected. */
export function toReversePolish(tokens: readonly Token[]): Token[] {
  const output: Token[] = [];
  const stack: Token[] = [];

  for (const token of tokens) {
    if (token.kind === 'number') {
      output.push(token);
      continue;
    }

    if (token.kind === 'operator') {
      const current = OPERATORS[token.symbol];
      while (stack.length > 0) {
        const top = stack.at(-1);
        if (top?.kind !== 'operator') break;
        const other = OPERATORS[top.symbol];
        const takesPrecedence =
          other.precedence > current.precedence ||
          (other.precedence === current.precedence && current.associativity === 'left');
        if (!takesPrecedence) break;
        output.push(pop(stack, 'Malformed expression.'));
      }
      stack.push(token);
      continue;
    }

    if (token.symbol === '(') {
      stack.push(token);
      continue;
    }

    let matched = false;
    while (stack.length > 0) {
      const top = pop(stack, 'Unbalanced parentheses.');
      if (top.kind === 'paren' && top.symbol === '(') {
        matched = true;
        break;
      }
      output.push(top);
    }
    if (!matched) throw new ToolExecutionError('Unbalanced parentheses: unexpected ")".');
  }

  while (stack.length > 0) {
    const top = pop(stack, 'Malformed expression.');
    if (top.kind === 'paren') throw new ToolExecutionError('Unbalanced parentheses: unclosed "(".');
    output.push(top);
  }

  return output;
}

export function evaluate(rpn: readonly Token[]): number {
  const stack: number[] = [];

  for (const token of rpn) {
    if (token.kind === 'number') {
      stack.push(token.value);
      continue;
    }
    if (token.kind === 'paren') throw new ToolExecutionError('Unbalanced parentheses.');

    const { arity } = OPERATORS[token.symbol];
    if (stack.length < arity)
      throw new ToolExecutionError('Malformed expression: missing operand.');

    if (arity === 1) {
      stack.push(-pop(stack, 'Malformed expression: missing operand.'));
      continue;
    }

    const right = pop(stack, 'Malformed expression: missing operand.');
    const left = pop(stack, 'Malformed expression: missing operand.');
    stack.push(apply(token.symbol, left, right));
  }

  if (stack.length !== 1) throw new ToolExecutionError('Malformed expression: too many operands.');

  const [result] = stack;
  if (result === undefined || !Number.isFinite(result)) {
    throw new ToolExecutionError('Expression did not evaluate to a finite number.');
  }
  return result;
}

function apply(symbol: OperatorSymbol, left: number, right: number): number {
  switch (symbol) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      if (right === 0) throw new ToolExecutionError('Division by zero.');
      return left / right;
    case '%':
      if (right === 0) throw new ToolExecutionError('Modulo by zero.');
      return left % right;
    case '^':
      return left ** right;
    case 'neg':
      throw new ToolExecutionError('Malformed expression.');
  }
}

/**
 * `Array.pop` returns `T | undefined`, and the alternative to handling that is an
 * `as` cast — which is exactly the kind of "I know better than the compiler" that
 * a parser handling hostile input should not contain.
 */
function pop<T>(stack: T[], message: string): T {
  const value = stack.pop();
  if (value === undefined) throw new ToolExecutionError(message);
  return value;
}

function render(token: Token): string {
  if (token.kind === 'number') return String(token.value);
  if (token.kind === 'paren') return token.symbol;
  return token.symbol;
}
