import type { AgentEvent, RunFailureReason, RunTrace } from '@ara/shared';

import { assistantText, toolUses, type LlmMessage, type LlmResponse } from '../llm/port.ts';
import { withRetry } from '../platform/retry.ts';
import { FinishPayloadSchema } from '../tools/finish.ts';
import type { ToolInvocation } from '../tools/registry.ts';
import { reviewCitations } from './citations.ts';
import { checkBudget, toRunBudgets } from './policy.ts';
import { buildSystemPrompt, FINISH_NUDGE } from './prompt.ts';
import { RunRecorder } from './recorder.ts';
import { executeToolCalls } from './toolStep.ts';
import type { AgentDeps, AgentRun } from './types.ts';

/**
 * Plan → act → observe → repeat, until the agent calls `finish` or runs out of rails.
 *
 * The loop does no I/O of its own: the model, the tools, the clock and the logger
 * all arrive in `deps`. Every exit is deliberate — there is no path out of here
 * that is not one of the outcomes in `RunOutcome`, and nothing throws past the
 * caller, because a run that dies silently is a run nobody can debug.
 */
export async function* runAgent(query: string, deps: AgentDeps): AgentRun {
  const { llm, tools, policy, clock, logger } = deps;
  const budgets = toRunBudgets(policy);
  const recorder = new RunRecorder({
    runId: deps.runId,
    query,
    budgets,
    modelId: llm.modelId,
    clock,
    ...(deps.emit === undefined ? {} : { emit: deps.emit }),
  });

  // One deadline for the whole run, handed to the model call and to every tool, so
  // a slow dependency is cut off rather than quietly eating the wall-clock budget.
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new Error('Run exceeded its wall-clock budget'));
  }, policy.maxWallClockMs);

  const messages: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: query }] }];
  const observedUrls = new Set<string>();
  const system = buildSystemPrompt(policy);
  let lastText = '';
  let nudges = 0;

  try {
    yield recorder.event({ type: 'run.started', query, budgets, modelId: llm.modelId });

    for (let step = 0; ; step += 1) {
      const verdict = checkBudget(policy, { step, elapsedMs: recorder.elapsedMs });
      if (!verdict.withinBudget) {
        return yield* fail(
          recorder,
          verdict.reason ?? 'budget_exceeded',
          verdict.message,
          lastText,
        );
      }

      yield recorder.event({ type: 'agent.step.started', step });
      const stepStartedAtMs = clock.now();

      let response: LlmResponse;
      try {
        response = await withRetry(
          () =>
            llm.complete({
              system,
              messages,
              tools: tools.toModelSpecs(),
              maxOutputTokens: policy.maxOutputTokens,
              signal: deadline.signal,
            }),
          { signal: deadline.signal },
        );
      } catch (error) {
        logger.error({ runId: deps.runId, step, err: error }, 'model call failed');
        return yield* fail(recorder, 'llm_error', describe(error), lastText);
      }
      recorder.addUsage(response.usage);

      const text = assistantText(response);
      if (text !== '') {
        lastText = text;
        yield recorder.event({ type: 'agent.message', step, text });
      }

      const requested = toolUses(response);
      if (requested.length === 0) {
        // Plain prose is not an answer. Correct it once; a model that ignores the
        // correction is looping, and looping is what the rails exist to stop.
        if (nudges < policy.maxNudges) {
          nudges += 1;
          recorder.addWarning({
            kind: 'missing_finish_call',
            message: 'The model answered without calling a tool and was asked to use finish.',
          });
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: [{ type: 'text', text: FINISH_NUDGE }] });
          continue;
        }
        return yield* fail(
          recorder,
          'no_tool_call',
          'The model would not use the finish tool, so the run was stopped rather than looped.',
          lastText,
        );
      }

      const executed = yield* executeToolCalls({
        step,
        calls: requested,
        policy,
        deps,
        recorder,
        signal: deadline.signal,
        observedUrls,
      });

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: executed.results });

      const endedAtMs = clock.now();
      recorder.addStep({
        index: step,
        startedAt: new Date(stepStartedAtMs).toISOString(),
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: endedAtMs - stepStartedAtMs,
        text,
        toolCalls: executed.records,
        usage: response.usage,
      });

      if (executed.finished !== undefined) {
        return yield* complete(recorder, executed.finished, observedUrls);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function* complete(
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

function* fail(
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'The model call failed.';
}
