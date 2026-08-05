import { describe, expect, it } from 'vitest';

import { createCalculatorTool } from './calculator.ts';
import { silentLogger } from '../platform/logger.ts';
import { ToolExecutionError, type ToolContext } from './types.ts';

const tool = createCalculatorTool();
const ctx: ToolContext = {
  runId: 'run_1',
  step: 0,
  signal: new AbortController().signal,
  logger: silentLogger,
};

async function evaluate(expression: string): Promise<number> {
  const { value } = await tool.execute({ expression }, ctx);
  return value;
}

describe('calculator arithmetic', () => {
  const cases: readonly (readonly [string, number])[] = [
    ['1 + 1', 2],
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['10 - 3 - 2', 5],
    ['100 / 5 / 2', 10],
    ['2 ^ 3 ^ 2', 512],
    ['-2 ^ 2', -4],
    ['(-2) ^ 2', 4],
    ['-5 + 3', -2],
    ['-(4 + 6)', -10],
    ['10 % 3', 1],
    ['1.5 * 4', 6],
    ['1e3 + 1', 1001],
    ['((((1))))', 1],
    ['3 * -2', -6],
    ['2 * (3 + -1)', 4],
  ];

  it.each(cases)('evaluates %s to %d', async (expression, expected) => {
    await expect(evaluate(expression)).resolves.toBe(expected);
  });

  it('applies left associativity to same-precedence operators', async () => {
    // The test that catches a naive right-to-left evaluator: it would give 5.
    await expect(evaluate('20 / 2 / 5')).resolves.toBe(2);
  });

  it('applies right associativity to exponentiation', async () => {
    // Left-associative would be (2^3)^2 = 64.
    await expect(evaluate('2 ^ 3 ^ 2')).resolves.toBe(512);
  });

  it('reports the parsed form so the model can check itself', async () => {
    const result = await tool.execute({ expression: '2 + 3 * 4' }, ctx);
    expect(result.normalizedExpression).toBe('2 3 4 * +');
  });
});

describe('calculator failures', () => {
  it('rejects division by zero rather than returning Infinity', async () => {
    await expect(evaluate('1 / 0')).rejects.toThrow(/Division by zero/u);
  });

  it('rejects modulo by zero', async () => {
    await expect(evaluate('1 % 0')).rejects.toThrow(/Modulo by zero/u);
  });

  it.each(['(1 + 2', '1 + 2)', '(()'])('rejects unbalanced parentheses in %s', async (expr) => {
    await expect(evaluate(expr)).rejects.toThrow(/parenthes/iu);
  });

  it.each(['1 +', '* 2', '1 2', '+'])('rejects the malformed expression %s', async (expr) => {
    await expect(evaluate(expr)).rejects.toThrow(ToolExecutionError);
  });

  it('rejects a result that is not finite', async () => {
    await expect(evaluate('9e300 * 9e300')).rejects.toThrow(/finite/u);
  });
});

describe('calculator refuses to be an execution sink', () => {
  // The reason this tool is a parser and not `eval`: each of these is a plausible
  // thing for a prompt-injected model to emit, and each one has to be inert.
  const attacks = [
    'process.exit(0)',
    'require("child_process").execSync("id")',
    'globalThis.process.exit(0)',
    '(() => 1)()',
    'constructor.constructor("return 1")()',
    '__proto__',
    '1; process.exit(0)',
    'fetch("http://169.254.169.254")',
    '`${process.env.ANTHROPIC_API_KEY}`',
  ];

  it.each(attacks)('rejects %s as a parse error', async (expression) => {
    // Not "returns a safe value" — the point is that it never becomes code.
    await expect(evaluate(expression)).rejects.toThrow(ToolExecutionError);
  });

  it('rejects the whole expression when only part of it is hostile', async () => {
    await expect(evaluate('1 + process.exit(0)')).rejects.toThrow(/Unexpected character/u);
  });
});

describe('calculator input schema', () => {
  it('rejects an expression longer than the cap before it is parsed', () => {
    const result = tool.inputSchema.safeParse({ expression: '1+'.repeat(200) });
    expect(result.success).toBe(false);
  });

  it('rejects a missing expression', () => {
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
  });
});
