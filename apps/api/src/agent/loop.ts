import type { AgentEvent, RunFailureReason, RunTrace } from '@ara/shared';

import { assistantText, toolUses, type LlmMessage, type LlmResponse } from '../llm/port.ts';
import { withRetry } from '../platform/retry.ts';
import { FinishPayloadSchema } from '../tools/finish.ts';
import type { ToolInvocation } from '../tools/registry.ts';
import {
  citesOnlyUnreadSources,
  createEvidence,
  unsupportedCitations,
  type Evidence,
} from './citations.ts';
import { complete, fail, recordStep } from './outcome.ts';
import { checkBudget, toRunBudgets } from './policy.ts';
import { buildQuoteNudge, buildSystemPrompt, FINISH_NUDGE, SOURCE_NUDGE } from './prompt.ts';
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
  // Accumulated across every tool call in the run, and read once at the end by the
  // grounding check: what the tools returned, and which URL each part came from.
  const evidence = createEvidence();
  const system = buildSystemPrompt(policy);
  let lastText = '';
  let nudges = 0;
  // A complete `finish` the loop chose not to ship yet, because it wanted the agent
  // to go back and improve the evidence under a citation. Held rather than dropped:
  // the correction is an improvement on an answer that already passed, so if the
  // turn that was meant to deliver it never lands, this is what the run returns.
  let held: ToolInvocation | undefined;

  try {
    yield recorder.event({ type: 'run.started', query, budgets, modelId: llm.modelId });

    for (let step = 0; ; step += 1) {
      const verdict = checkBudget(policy, { step, elapsedMs: recorder.elapsedMs });
      if (!verdict.withinBudget) {
        return yield* settle(
          recorder,
          evidence,
          held,
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
        // The deadline aborting a model call mid-flight is not a provider failure,
        // and reporting it as one sends the user to "try again in a moment" when the
        // fix is a longer budget. The signal is the only thing that knows which
        // happened, because an aborted SDK call throws its own generic error.
        if (deadline.signal.aborted) {
          logger.warn({ runId: deps.runId, step }, 'model call cut off by wall-clock budget');
          return yield* settle(
            recorder,
            evidence,
            held,
            'budget_exceeded',
            `Stopped mid-answer: the run hit its ${String(Math.round(policy.maxWallClockMs / 1000))}s time limit while the model was still writing.`,
            lastText,
          );
        }
        // Logged as an error even when there is a held answer to fall back on: the
        // provider did fail, and the run reporting "completed" is the one place that
        // failure would otherwise leave no trace at all.
        logger.error({ runId: deps.runId, step, err: error }, 'model call failed');
        return yield* settle(recorder, evidence, held, 'llm_error', describeError(error), lastText);
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
        //
        // Not raised when there is a held answer: that answer's citations *were*
        // checked, and the warning would say the opposite of what happened.
        if (held === undefined) {
          recorder.addWarning({
            kind: 'missing_finish_call',
            message:
              'The model gave its answer as prose instead of calling finish, so its citations were never checked.',
          });
        }
        return yield* settle(
          recorder,
          evidence,
          held,
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
        evidence,
      });

      // Asked before the results are handed back, so the correction can ride in the
      // same user message rather than as a second one — two consecutive user turns
      // are not a shape the Messages API takes.
      const correction =
        executed.finished !== undefined && nudges < policy.maxNudges
          ? correctionFor(executed.finished, evidence)
          : undefined;

      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content:
          correction === undefined
            ? executed.results
            : [...executed.results, { type: 'text', text: correction }],
      });

      recordStep(recorder, clock, step, stepStartedAtMs, text, executed.records, response.usage);

      if (executed.finished !== undefined) {
        // The answer is fine and the sources are real; only the evidence under them
        // is second-hand or misquoted, and the agent still has budget to go and fix
        // it. Sending it back costs a step and is capped, so the worst case is one
        // wasted step and the same answer — which the labels would have described
        // anyway.
        //
        // That "worst case" is only true because the answer is kept. Without the
        // hand-off to `held`, a correction turn that failed took a finished run
        // down with it.
        if (correction !== undefined) {
          held = executed.finished;
          nudges += 1;
          continue;
        }
        return yield* complete(recorder, executed.finished, evidence);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'The model call failed.';
}

/**
 * How a run ends once it has run out of ways to continue — with the best complete
 * answer it has, if it has one.
 *
 * `held` is a `finish` that passed everything except the loop's own opinion that
 * the agent could do better, so it was sent back for one more turn. That opinion is
 * worth a step; it is not worth the run. If the turn meant to deliver the
 * improvement never lands, shipping the held answer returns a complete, checked
 * result where failing would have returned nothing — and the citation labels on it
 * say exactly what the correction was going to be about anyway.
 *
 * The fallback is announced rather than silent. A run that reports "completed"
 * after the provider fell over is a run whose failure left no mark on the thing
 * anybody reads, and the whole point of the citation labels is that the interesting
 * failures are the ones you can see.
 */
function* settle(
  recorder: RunRecorder,
  evidence: Evidence,
  held: ToolInvocation | undefined,
  reason: RunFailureReason,
  message: string | undefined,
  partialAnswer: string,
): Generator<AgentEvent, RunTrace, void> {
  if (held === undefined) return yield* fail(recorder, reason, message, partialAnswer);

  // The cause goes last rather than mid-sentence: it is a whole sentence of its
  // own, punctuation included, and splicing it into one produced "…provides.. This".
  recorder.addWarning({
    kind: 'uncorrected_citation',
    message:
      'The agent was asked to go back and strengthen the evidence under a citation, and that ' +
      'turn did not finish, so this is the answer it had from before the correction — the ' +
      `labels on the sources are the check on it. The turn stopped because: ${message ?? 'the run stopped.'}`,
  });

  return yield* complete(recorder, held, evidence);
}

/**
 * Reads the citations out of a `finish` call and asks what, if anything, is worth
 * sending the agent back for.
 *
 * Parsing here rather than reusing `complete`'s parse keeps the question cheap and
 * side-effect free: nothing is recorded, no warning is raised, and the payload is
 * parsed again for real if the run does go on to finish.
 *
 * A quote that is not in the page outranks an answer built from snippets. Both are
 * weak evidence, but only one is an attribution the source never made, and the
 * nudge budget buys a single correction — so it is spent on the citation that says
 * something false rather than the one that is merely second-hand.
 */
function correctionFor(finished: ToolInvocation, evidence: Evidence): string | undefined {
  if (finished.outcome.status !== 'ok') return undefined;

  const payload = FinishPayloadSchema.safeParse(finished.outcome.output);
  if (!payload.success) return undefined;

  const failed = unsupportedCitations(payload.data.citations, evidence);
  if (failed.length > 0) return buildQuoteNudge(failed);

  return citesOnlyUnreadSources(payload.data.citations, evidence) ? SOURCE_NUDGE : undefined;
}
