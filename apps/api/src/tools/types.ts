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
 * What a tool's output is worth when a citation's quote is checked against it.
 *
 * The distinction the grounding check cannot make for itself: a page body and a
 * search snippet are both strings attached to a URL, and by the time the check runs
 * they are indistinguishable. Only the tool knows which it produced.
 *
 * - `fetched` — the tool went to the URL and returned what it served. The source's
 *   own words.
 * - `snippet` — the tool returned somebody else's summary of the URL. Real text
 *   about a real page, written by neither the page nor the agent.
 * - `none` — the output is not evidence about any URL. Arithmetic, or the agent's
 *   own claims echoed back.
 */
export type ToolEvidence = 'fetched' | 'snippet' | 'none';

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
  /**
   * Declared here rather than inferred at the call site, so adding a tool stays one
   * file plus one line in `index.ts` — and so a new tool has to answer the question
   * rather than silently defaulting into being treated as a source.
   */
  readonly evidence: ToolEvidence;
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
