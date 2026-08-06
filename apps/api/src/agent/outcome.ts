import type {
  AgentEvent,
  RunFailureReason,
  RunTrace,
  ToolCallRecord,
  TokenUsage,
} from '@ara/shared';

import { FinishPayloadSchema } from '../tools/finish.ts';
import type { ToolInvocation } from '../tools/registry.ts';
import { reviewCitations } from './citations.ts';
import type { RunRecorder } from './recorder.ts';
import type { Clock } from './types.ts';

/**
 * How a run ends, and how each step reaches the trace on the way.
 *
 * Split out of `loop.ts` so that file is only the decisions the agent makes: the
 * loop chooses *whether* to stop, and these three functions do the bookkeeping of
 * stopping.
 */
/** Every step reaches the trace the same way, whether or not it called a tool. */
export function recordStep(
  recorder: RunRecorder,
  clock: Clock,
  index: number,
  startedAtMs: number,
  text: string,
  toolCalls: ToolCallRecord[],
  usage: TokenUsage,
): void {
  const endedAtMs = clock.now();
  recorder.addStep({
    index,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - startedAtMs,
    text,
    toolCalls,
    usage,
  });
}

export function* complete(
  recorder: RunRecorder,
  finished: ToolInvocation,
  observedUrls: ReadonlySet<string>,
): Generator<AgentEvent, RunTrace, void> {
  const payload = FinishPayloadSchema.parse(
    finished.outcome.status === 'ok' ? finished.outcome.output : {},
  );

  // The anti-hallucination check, applied before the answer is ever shown.
  const review = reviewCitations(payload.citations, observedUrls);
  for (const warning of review.warnings) recorder.addWarning(warning);

  yield recorder.event({ type: 'answer.delta', text: payload.answer });
  yield recorder.event({
    type: 'run.completed',
    ...recorder.summary,
    answer: payload.answer,
    citations: [...review.citations],
    warnings: [...recorder.warnings],
  });

  return recorder.succeeded(payload.answer, review.citations);
}

export function* fail(
  recorder: RunRecorder,
  reason: RunFailureReason,
  message: string | undefined,
  partialAnswer: string,
): Generator<AgentEvent, RunTrace, void> {
  const detail = message ?? 'The run stopped.';

  yield recorder.event({
    type: 'run.failed',
    ...recorder.summary,
    reason,
    message: detail,
    ...(partialAnswer === '' ? {} : { partialAnswer }),
    warnings: [...recorder.warnings],
  });

  return recorder.failed(reason, detail, partialAnswer);
}
