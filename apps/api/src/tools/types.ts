import type { z } from 'zod';

import type { Logger } from '../platform/logger.ts';

/**
 * Everything a tool is given at call time. Tools never read `process.env`, never
 * touch the console, and never reach for a module-level singleton — if a tool
 * needs something, it arrives here or in its factory, which is what makes the
 * whole tool layer testable without a network or a clock.
 */
export interface ToolContext {
  readonly runId: string;
  readonly step: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

/**
 * One tool, one object. `inputSchema` does double duty: it validates what the
 * model sent, and it is converted to JSON Schema to tell the model what to send.
 * One definition means the validator and the advertised contract cannot disagree.
 */
export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  /** Written for the model, not for humans — it is prompt text, and it is read as such. */
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  readonly timeoutMs: number;
  execute(input: I, ctx: ToolContext): Promise<O>;
}

/**
 * A failure the model is meant to see and recover from — a bad URL, a malformed
 * expression, a page that would not parse. The message goes back to the model as
 * a tool result, so write it as guidance, not as a stack trace.
 */
export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}
