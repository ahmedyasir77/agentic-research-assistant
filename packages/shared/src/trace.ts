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

export const CitationSchema = z.object({
  id: z.number().int().positive(),
  url: z.url(),
  title: z.string(),
});
export type Citation = z.infer<typeof CitationSchema>;

/**
 * A citation the agent claimed, plus whether a tool in this run actually returned
 * that URL. Unverified ones are kept rather than deleted so the UI can show the
 * anti-hallucination check doing its job.
 */
export const VerifiedCitationSchema = CitationSchema.extend({ verified: z.boolean() });
export type VerifiedCitation = z.infer<typeof VerifiedCitationSchema>;

export const RunWarningSchema = z.object({
  kind: z.enum(['unverified_citation', 'invalid_tool_arguments', 'missing_finish_call']),
  message: z.string(),
});
export type RunWarning = z.infer<typeof RunWarningSchema>;

/** Every way a run can end badly. Each one is a deliberate stop, not an exception. */
export const RunFailureReasonSchema = z.enum([
  'budget_exceeded',
  'no_tool_call',
  'llm_error',
  'internal_error',
]);
export type RunFailureReason = z.infer<typeof RunFailureReasonSchema>;

/** The label on `agent_runs_total{outcome}` — success plus every failure reason. */
export const RunOutcomeSchema = z.enum(['completed', ...RunFailureReasonSchema.options]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const RunStatusSchema = z.enum(['running', 'succeeded', 'failed']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TRACE_SCHEMA_VERSION = 1;

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
