import { z } from 'zod';

import { JsonValueSchema } from './json.ts';

/** ISO 8601. The trace is read by humans during a demo, so timestamps are readable. */
export const TimestampSchema = z.iso.datetime();

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** The budgets the run is being held to — sent to the browser so the UI can show "3 of 8 steps". */
export const RunBudgetsSchema = z.object({
  maxSteps: z.number().int().positive(),
  maxWallClockMs: z.number().int().positive(),
  maxToolCallsPerStep: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
});
export type RunBudgets = z.infer<typeof RunBudgetsSchema>;

/**
 * Why a tool call did not produce output. Every one of these is a normal, expected
 * outcome that the model gets to see and react to — none of them throw.
 */
export const ToolErrorKindSchema = z.enum([
  'unknown_tool',
  'invalid_arguments',
  'invalid_output',
  'timeout',
  'execution_failed',
]);
export type ToolErrorKind = z.infer<typeof ToolErrorKindSchema>;

export const ToolErrorSchema = z.object({
  kind: ToolErrorKindSchema,
  message: z.string(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export const ToolOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), output: JsonValueSchema }),
  z.object({ status: z.literal('error'), error: ToolErrorSchema }),
]);
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>;

export const ToolCallRecordSchema = z.object({
  callId: z.string().min(1),
  tool: z.string().min(1),
  /** Redacted before it reaches the trace — see platform/redact.ts. */
  args: JsonValueSchema,
  outcome: ToolOutcomeSchema,
  durationMs: z.number().nonnegative(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export const RunStepSchema = z.object({
  index: z.number().int().nonnegative(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  durationMs: z.number().nonnegative(),
  /** What the model said out loud on this step, before deciding what to call. */
  text: z.string(),
  toolCalls: z.array(ToolCallRecordSchema),
  usage: TokenUsageSchema,
});
export type RunStep = z.infer<typeof RunStepSchema>;

/**
 * The longest a citation quote may be.
 *
 * Lives here rather than beside `finish`, because it is not only that tool's
 * business. It is the cap the model is told about, the length an over-long quote is
 * clamped to — and the distance consecutive `http_get` reads overlap by, so that a
 * sentence lying across the cut between two reads is still whole in one of them. A
 * second copy of this number in the fetch tool would be a silent way for the
 * grounding check to start rejecting quotes that really are in the page.
 */
export const MAX_QUOTE_CHARS = 500;

export const CitationSchema = z.object({
  id: z.number().int().positive(),
  url: z.url(),
  title: z.string(),
  /**
   * The sentence in that source which supports the claim, copied verbatim.
   *
   * Deliberately optional, and deliberately unbounded below: a model that offers a
   * quote too short to be evidence should be told so by the check, not rejected by
   * the validator. A `finish` call that fails validation costs a step and teaches
   * the model nothing — see the note on the citations array in tools/finish.ts.
   */
  quote: z.string().max(MAX_QUOTE_CHARS).optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

/**
 * How well a claimed citation stood up, from strongest to weakest.
 *
 * - `quoted` — the quote appears verbatim in the page body a tool actually fetched.
 *   The only state in which the source has been checked, in its own words, at the
 *   level of the actual claim.
 * - `snippet` — the quote appears only in a search result's snippet for this URL,
 *   never in the page itself. The words are the search provider's summary of the
 *   source rather than the source, and no tool ever read the page — so the claim is
 *   checked against a description of the evidence instead of the evidence.
 * - `unsupported` — a tool returned this URL, but the quote is not in what it
 *   returned. A real source attached to words it never said, which is the failure
 *   URL checking alone cannot see.
 * - `url_only` — a tool returned this URL and no quote was offered, so only the
 *   source could be checked, not the claim.
 * - `unobserved` — no tool returned this URL during the run. A fabricated source.
 */
export const CitationGroundingSchema = z.enum([
  'quoted',
  'snippet',
  'unsupported',
  'url_only',
  'unobserved',
]);
export type CitationGrounding = z.infer<typeof CitationGroundingSchema>;

/**
 * Where the quote was found, split so the UI can highlight the match without
 * searching for it again. `match` is the source's own wording, which is not always
 * byte-identical to the quote the model sent — that is the point of showing it.
 */
export const QuoteMatchSchema = z.object({
  before: z.string(),
  match: z.string(),
  after: z.string(),
});
export type QuoteMatch = z.infer<typeof QuoteMatchSchema>;

/**
 * A citation the agent claimed, plus the verdict of the grounding check. Citations
 * that failed are kept rather than deleted so the UI can show the check doing its
 * job — a shortened list would hide exactly the thing worth seeing.
 */
export const VerifiedCitationSchema = CitationSchema.extend({
  grounding: CitationGroundingSchema,
  /** The passage the quote matched, in context. Set on `quoted` and `snippet`. */
  quoteMatch: QuoteMatchSchema.optional(),
});
export type VerifiedCitation = z.infer<typeof VerifiedCitationSchema>;

export const RunWarningSchema = z.object({
  kind: z.enum([
    'unverified_citation',
    'unsupported_quote',
    'invalid_tool_arguments',
    'missing_finish_call',
    /** A finish was shipped without the correction the loop went back to ask for. */
    'uncorrected_citation',
  ]),
  message: z.string(),
});
export type RunWarning = z.infer<typeof RunWarningSchema>;

/** Every way a run can end badly. Each one is a deliberate stop, not an exception. */
export const RunFailureReasonSchema = z.enum([
  'budget_exceeded',
  'no_tool_call',
  'llm_error',
  'internal_error',
  'cancelled',
]);
export type RunFailureReason = z.infer<typeof RunFailureReasonSchema>;

/** The label on `agent_runs_total{outcome}` — success plus every failure reason. */
export const RunOutcomeSchema = z.enum(['completed', ...RunFailureReasonSchema.options]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const RunStatusSchema = z.enum(['running', 'succeeded', 'failed']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TRACE_SCHEMA_VERSION = 2;

/**
 * The whole run, replayable after it ends. This is the demo artifact — a reviewer
 * should be able to read one of these and reconstruct exactly what the agent did.
 */
export const RunTraceSchema = z.object({
  v: z.literal(TRACE_SCHEMA_VERSION),
  runId: z.string().min(1),
  query: z.string(),
  status: RunStatusSchema,
  outcome: RunOutcomeSchema.optional(),
  failureMessage: z.string().optional(),
  budgets: RunBudgetsSchema,
  modelId: z.string(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
  durationMs: z.number().nonnegative(),
  steps: z.array(RunStepSchema),
  answer: z.string().optional(),
  citations: z.array(VerifiedCitationSchema),
  warnings: z.array(RunWarningSchema),
  usage: TokenUsageSchema,
  estimatedCostUsd: z.number().nonnegative(),
});
export type RunTrace = z.infer<typeof RunTraceSchema>;
