import { z } from 'zod';

import { JsonValueSchema } from './json.ts';
import {
  RunBudgetsSchema,
  RunFailureReasonSchema,
  TimestampSchema,
  TokenUsageSchema,
  ToolErrorSchema,
  VerifiedCitationSchema,
  RunWarningSchema,
} from './trace.ts';

/**
 * Bumped whenever an event's shape changes in a way an older browser tab could not
 * read. The client checks it and asks the user to reload rather than rendering
 * half-understood events.
 */
export const EVENT_SCHEMA_VERSION = 2;

/**
 * `seq` is monotonic per run: a client that drops its connection and re-attaches
 * can tell what it missed, and a replayed trace can be diffed against the stream.
 */
const envelope = {
  v: z.literal(EVENT_SCHEMA_VERSION),
  seq: z.number().int().nonnegative(),
  runId: z.string().min(1),
  ts: TimestampSchema,
};

const stepIndex = z.number().int().nonnegative();

/** What the run cost, attached to whichever event ends the run. */
const runSummary = {
  steps: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  usage: TokenUsageSchema,
  estimatedCostUsd: z.number().nonnegative(),
};

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...envelope,
    type: z.literal('run.started'),
    query: z.string(),
    budgets: RunBudgetsSchema,
    modelId: z.string(),
  }),
  z.object({ ...envelope, type: z.literal('agent.step.started'), step: stepIndex }),
  z.object({ ...envelope, type: z.literal('agent.message'), step: stepIndex, text: z.string() }),
  z.object({
    ...envelope,
    type: z.literal('tool.called'),
    step: stepIndex,
    callId: z.string().min(1),
    tool: z.string().min(1),
    args: JsonValueSchema,
  }),
  z.object({
    ...envelope,
    type: z.literal('tool.succeeded'),
    step: stepIndex,
    callId: z.string().min(1),
    tool: z.string().min(1),
    durationMs: z.number().nonnegative(),
    output: JsonValueSchema,
  }),
  z.object({
    ...envelope,
    type: z.literal('tool.failed'),
    step: stepIndex,
    callId: z.string().min(1),
    tool: z.string().min(1),
    durationMs: z.number().nonnegative(),
    error: ToolErrorSchema,
  }),
  // The answer arrives as deltas so the UI appends rather than waits. Today the
  // loop emits one delta holding the validated answer; a streaming LLM adapter
  // can emit many without the contract changing.
  z.object({ ...envelope, type: z.literal('answer.delta'), text: z.string() }),
  z.object({
    ...envelope,
    type: z.literal('run.completed'),
    ...runSummary,
    answer: z.string(),
    citations: z.array(VerifiedCitationSchema),
    warnings: z.array(RunWarningSchema),
  }),
  z.object({
    ...envelope,
    type: z.literal('run.failed'),
    ...runSummary,
    reason: RunFailureReasonSchema,
    message: z.string(),
    // A budget-exceeded run still hands back whatever the agent had — a failed
    // run is not an empty run.
    partialAnswer: z.string().optional(),
    warnings: z.array(RunWarningSchema),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent['type'];
