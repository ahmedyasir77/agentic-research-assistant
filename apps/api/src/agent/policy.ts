import type { RunBudgets, RunFailureReason } from '@ara/shared';

import type { Config } from '../config/env.ts';

/**
 * The agent's rails, in one object.
 *
 * A reason-act loop is an unbounded `while (true)` with a language model deciding
 * when to stop. Every limit that makes that safe to run in production is here, so
 * the answer to "what stops it looping forever" is a file, not a story.
 */
export interface AgentPolicy extends RunBudgets {
  /**
   * How many times the loop will send a correction back to the model — to use the
   * `finish` tool instead of plain prose, to cite a source the run actually has
   * instead of one nothing returned, or to re-read a source instead of shipping a
   * quote that is not in it. Two, not one: a citation nudge names the exact source
   * that failed and the fix is mechanical (read again, copy exactly), which
   * a model routinely gets right on a second attempt but not always on the first.
   * The budget is shared with the prose correction so a run that needed both still
   * pays for only two extra steps, not four.
   */
  readonly maxNudges: number;
}

/**
 * Sized for a question that needs real research rather than a lookup.
 *
 * The old 8 steps and 60s fitted a demo question — search, read, finish — and cut
 * off anything larger mid-sentence. 14 was the next line drawn, and a real run still
 * found the edge of it: several sources, several offsets into a truncated page, and
 * a citation correction round each cost a step, and a question with more than a
 * couple of sources ran out before `finish` did. The budget has to cover the honest
 * version of the work, or the rails stop bounding a runaway loop and start
 * truncating ordinary runs.
 */
export const DEFAULT_POLICY: AgentPolicy = {
  maxSteps: 20,
  maxWallClockMs: 180_000,
  maxToolCallsPerStep: 3,
  maxOutputTokens: 4_096,
  maxNudges: 2,
};

export function policyFromConfig(config: Config): AgentPolicy {
  return {
    maxSteps: config.budgets.maxSteps,
    maxWallClockMs: config.budgets.maxWallClockMs,
    maxToolCallsPerStep: config.budgets.maxToolCallsPerStep,
    maxOutputTokens: config.budgets.maxOutputTokens,
    maxNudges: DEFAULT_POLICY.maxNudges,
  };
}

export interface BudgetState {
  /** Steps already completed — the step about to start is `step`. */
  readonly step: number;
  readonly elapsedMs: number;
}

export interface BudgetVerdict {
  readonly withinBudget: boolean;
  readonly reason?: RunFailureReason;
  readonly message?: string;
}

const WITHIN_BUDGET: BudgetVerdict = { withinBudget: true };

/**
 * Checked before each step rather than after, so a run that has run out of budget
 * stops before spending another model call — and stops with whatever it has,
 * which is the difference between a partial answer and a crash.
 */
export function checkBudget(policy: AgentPolicy, state: BudgetState): BudgetVerdict {
  if (state.step >= policy.maxSteps) {
    return {
      withinBudget: false,
      reason: 'budget_exceeded',
      message: `Stopped after ${String(policy.maxSteps)} steps, the configured limit.`,
    };
  }

  if (state.elapsedMs >= policy.maxWallClockMs) {
    return {
      withinBudget: false,
      reason: 'budget_exceeded',
      message: `Stopped after ${String(Math.round(state.elapsedMs / 1000))}s, the configured time limit.`,
    };
  }

  return WITHIN_BUDGET;
}

export function toRunBudgets(policy: AgentPolicy): RunBudgets {
  return {
    maxSteps: policy.maxSteps,
    maxWallClockMs: policy.maxWallClockMs,
    maxToolCallsPerStep: policy.maxToolCallsPerStep,
    maxOutputTokens: policy.maxOutputTokens,
  };
}
