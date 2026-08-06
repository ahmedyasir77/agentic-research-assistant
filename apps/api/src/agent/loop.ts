import { assistantText, toolUses, type LlmMessage, type LlmResponse } from '../llm/port.ts';
import { withRetry } from '../platform/retry.ts';
import { complete, fail, recordStep } from './outcome.ts';
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
        return yield* fail(recorder, 'llm_error', describeError(error), lastText);
      }
      recorder.addUsage(response.usage);

      const text = assistantText(response);
      if (text !== '') {
        lastText = text;
        yield recorder.event({ type: 'agent.message', step, text });
      }

      const requested = toolUses(response);
      if (requested.length === 0) {
        // A turn that called nothing still spent a model call and a step, so it
        // belongs in the trace like any other. Leaving it out made the trace
        // disagree with the event stream about how long a run was.
        recordStep(recorder, clock, step, stepStartedAtMs, text, [], response.usage);

        // Plain prose is not an answer. Correct it once; a model that ignores the
        // correction is looping, and looping is what the rails exist to stop.
        if (nudges < policy.maxNudges) {
          nudges += 1;
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: [{ type: 'text', text: FINISH_NUDGE }] });
          continue;
        }

        // Warned about only once the correction has failed. A model that answers
        // in prose and then does as it is told has cost a step, which the trace
        // now shows — it has not made the answer any less trustworthy, and that is
        // what a warning is for.
        recorder.addWarning({
          kind: 'missing_finish_call',
          message:
            'The model gave its answer as prose instead of calling finish, so its citations were never checked.',
        });
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

      recordStep(recorder, clock, step, stepStartedAtMs, text, executed.records, response.usage);

      if (executed.finished !== undefined) {
        return yield* complete(recorder, executed.finished, observedUrls);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'The model call failed.';
}
