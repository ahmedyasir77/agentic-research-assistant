import { useEffect, useState, type JSX } from 'react';

import { isRunning, type RunState } from '../lib/runReducer.ts';

export interface CountersProps {
  readonly state: RunState;
}

/**
 * What the run is spending. Elapsed time and steps update live; tokens and cost
 * arrive with the event that ends the run, because that is when the server knows
 * them — showing a guess in the meantime would be worse than showing a dash.
 */
export function Counters({ state }: CountersProps): JSX.Element {
  const elapsedMs = useElapsed(state);
  const steps = state.steps.length;
  const maxSteps = state.budgets?.maxSteps;
  const overTime =
    state.budgets !== undefined && elapsedMs >= state.budgets.maxWallClockMs && isRunning(state);

  return (
    <dl className="counters">
      <div>
        <dt className="counter__label">Elapsed</dt>
        <dd className={`counter__value${overTime ? ' counter__value--over' : ''}`}>
          {(elapsedMs / 1000).toFixed(1)}s
        </dd>
      </div>
      <div>
        <dt className="counter__label">Steps</dt>
        <dd
          className={`counter__value${maxSteps !== undefined && steps >= maxSteps ? ' counter__value--over' : ''}`}
        >
          {steps} / {maxSteps ?? '—'}
        </dd>
      </div>
      <div>
        <dt className="counter__label">Tokens</dt>
        <dd className="counter__value">
          {state.usage.inputTokens + state.usage.outputTokens === 0
            ? '—'
            : `${formatCount(state.usage.inputTokens)} in · ${formatCount(state.usage.outputTokens)} out`}
        </dd>
      </div>
      <div>
        <dt className="counter__label">Est. cost</dt>
        <dd className="counter__value">{formatCost(state)}</dd>
      </div>
    </dl>
  );
}

/**
 * The clock ticks here rather than in the reducer, so run state stays a pure
 * function of the events and this component owns the only interval on the page.
 */
function useElapsed(state: RunState): number {
  const { startedAtMs, durationMs } = state;
  const live = isRunning(state);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 100);
    return () => {
      clearInterval(timer);
    };
  }, [live]);

  if (durationMs !== undefined) return durationMs;
  if (startedAtMs === undefined) return 0;
  return Math.max(0, now - startedAtMs);
}

function formatCount(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

function formatCost(state: RunState): string {
  if (state.durationMs === undefined) return '—';
  // The offline demo genuinely costs nothing, and saying "$0.0000" would read as a
  // rounding artefact rather than the truth.
  if (state.estimatedCostUsd === 0) return 'free';
  return `$${state.estimatedCostUsd.toFixed(4)}`;
}
