import { JsonValueSchema, type ToolOutcome, type ToolSpec } from '@ara/shared';
import { z } from 'zod';

import { toolCallsTotal, toolDurationSeconds } from '../platform/metrics.ts';
import { TimeoutError, withTimeout } from '../platform/timeout.ts';
import { ToolExecutionError, type Tool, type ToolContext, type ToolEvidence } from './types.ts';

export interface ToolInvocation {
  readonly outcome: ToolOutcome;
  readonly durationMs: number;
}

export interface ToolRegistryOptions {
  /** Injected so a run's trace is byte-identical between test runs. */
  readonly now?: () => number;
}

/**
 * Holds the tools, describes them to the model, and runs them.
 *
 * `invoke` never throws. Every way a tool call can go wrong — a name the model
 * invented, arguments that do not validate, a timeout, a crash — comes back as a
 * structured outcome that the loop turns into a `tool_result` with `is_error`.
 * That is what lets the model read its own mistake and correct it on the next
 * turn instead of taking the run down with it.
 */
export class ToolRegistry {
  readonly #tools: ReadonlyMap<string, Tool>;
  readonly #now: () => number;
  #modelSpecs: ToolSpec[] | undefined;

  constructor(tools: readonly Tool[], options: ToolRegistryOptions = {}) {
    const byName = new Map<string, Tool>();
    for (const tool of tools) {
      if (byName.has(tool.name)) {
        throw new Error(`Duplicate tool name "${tool.name}" — tool names address the tool.`);
      }
      byName.set(tool.name, tool);
    }
    this.#tools = byName;
    this.#now = options.now ?? (() => performance.now());
  }

  get names(): readonly string[] {
    return [...this.#tools.keys()];
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /**
   * What a tool's output is worth when a citation is checked against it.
   *
   * An unknown name is `none` rather than an error: a call that never resolved to a
   * tool produced a failure message, not a source, and nothing in it should be
   * quotable.
   */
  evidenceFor(name: string): ToolEvidence {
    return this.#tools.get(name)?.evidence ?? 'none';
  }

  /**
   * The tool list as the model receives it. The JSON Schema is generated from the
   * same Zod schema `invoke` validates against, so what the model is told and what
   * it is held to are the same object.
   *
   * Cached on first call: the tool set is fixed for the life of the registry, so
   * every step of every run would otherwise re-walk the same Zod schemas to
   * produce the same JSON Schema.
   */
  toModelSpecs(): ToolSpec[] {
    this.#modelSpecs ??= [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: JsonValueSchema.parse(z.toJSONSchema(tool.inputSchema, { io: 'input' })),
      timeoutMs: tool.timeoutMs,
    }));
    return this.#modelSpecs;
  }

  async invoke(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolInvocation> {
    const startedAt = this.#now();
    const tool = this.#tools.get(name);

    if (tool === undefined) {
      return this.#record(name, startedAt, {
        status: 'error',
        error: {
          kind: 'unknown_tool',
          message: `No tool named "${name}". Available tools: ${this.names.join(', ')}.`,
        },
      });
    }

    const parsedInput = tool.inputSchema.safeParse(rawArgs);
    if (!parsedInput.success) {
      return this.#record(name, startedAt, {
        status: 'error',
        error: {
          kind: 'invalid_arguments',
          message: `Invalid arguments for ${name}: ${describe(parsedInput.error)}`,
        },
      });
    }

    try {
      const output = await withTimeout(
        (signal) => tool.execute(parsedInput.data, { ...ctx, signal }),
        { label: `tool ${name}`, timeoutMs: tool.timeoutMs, signal: ctx.signal },
      );

      const parsedOutput = tool.outputSchema.safeParse(output);
      if (!parsedOutput.success) {
        // The tool broke its own contract. The model cannot fix that, so say so
        // plainly rather than handing it a schema error to puzzle over.
        ctx.logger.error({ tool: name, issues: parsedOutput.error.issues }, 'tool output invalid');
        return this.#record(name, startedAt, {
          status: 'error',
          error: { kind: 'invalid_output', message: `${name} returned a malformed result.` },
        });
      }

      return this.#record(name, startedAt, {
        status: 'ok',
        output: JsonValueSchema.parse(parsedOutput.data),
      });
    } catch (error) {
      return this.#record(name, startedAt, {
        status: 'error',
        error: toToolError(name, error, ctx),
      });
    }
  }

  #record(tool: string, startedAt: number, outcome: ToolOutcome): ToolInvocation {
    const durationMs = this.#now() - startedAt;
    toolCallsTotal.inc({ tool, outcome: outcome.status === 'ok' ? 'ok' : outcome.error.kind });
    toolDurationSeconds.observe({ tool }, durationMs / 1000);
    return { outcome, durationMs };
  }
}

function toToolError(
  name: string,
  error: unknown,
  ctx: ToolContext,
): { kind: 'timeout' | 'execution_failed'; message: string } {
  if (error instanceof TimeoutError) {
    return { kind: 'timeout', message: `${name} timed out after ${String(error.timeoutMs)}ms.` };
  }
  if (error instanceof ToolExecutionError) {
    return { kind: 'execution_failed', message: error.message };
  }
  // An unexpected throw is our bug, not the model's. Log the detail and give the
  // model something true but uninformative rather than leaking internals.
  ctx.logger.error({ tool: name, err: error }, 'tool threw an unexpected error');
  return { kind: 'execution_failed', message: `${name} failed unexpectedly.` };
}

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}
