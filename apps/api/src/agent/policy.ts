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
   * How many times the loop will tell a model that answered in plain prose to use
   * the `finish` tool instead. One is enough: a model that ignores the correction
   * twice is not going to be talked round on the third attempt.
   */
  readonly maxNudges: number;
}

/**
 * Sized for a question that needs real research rather than a lookup.
 *
 * The old 8 steps and 60s fitted a demo question — search, read, finish — and cut
 * off anything larger mid-sentence. An open question costs more than that before
 * anyone has done anything wrong: several sources read, a long answer written, and
 * possibly a correction round after the grounding check sends the agent back for a
 * quote. The budget has to cover the honest version of the work, or the rails stop
 * bounding a runaway loop and start truncating ordinary runs.
 */
export const DEFAULT_POLICY: AgentPolicy = {
  maxSteps: 14,
  maxWallClockMs: 180_000,
  maxToolCallsPerStep: 3,
  maxOutputTokens: 4_096,
  maxNudges: 1,
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
