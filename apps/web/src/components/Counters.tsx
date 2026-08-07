import { useEffect, useState, type JSX } from 'react';

import { isRunning, type RunState } from '../lib/runReducer.ts';
import { Meter } from './Glyphs.tsx';

export interface CountersProps {
  readonly state: RunState;
}

/**
 * What the run is spending. Elapsed time and steps update live; tokens and cost
 * arrive with the event that ends the run, because that is when the server knows
 * them — showing a guess in the meantime would be worse than showing a dash.
 *
 * Laid out as DESIGN.md §5 lays out a table: no outer border, headers separated
 * from values by a single rule, nothing boxed. The step budget gets the §8
 * progress bar underneath, which is the one number here with a known ceiling —
 * elapsed time has one too, but a bar that fills as a deadline approaches reads
 * as a countdown, and the run is not on a countdown.
 */
export function Counters({ state }: CountersProps): JSX.Element {
  const elapsedMs = useElapsed(state);
  const steps = state.steps.length;
  const maxSteps = state.budgets?.maxSteps;
  const overTime =
    state.budgets !== undefined && elapsedMs >= state.budgets.maxWallClockMs && isRunning(state);
  const overSteps = maxSteps !== undefined && steps >= maxSteps;

  return (
    <section className="counters" aria-label="Run budget">
      <dl className="table">
        <div className="table__col">
          <dt className="table__head">Elapsed</dt>
          <dd className={`table__cell${overTime ? ' table__cell--over' : ''}`}>
            {(elapsedMs / 1000).toFixed(1)}s
          </dd>
        </div>
        <div className="table__col">
          <dt className="table__head">Steps</dt>
          <dd className={`table__cell${overSteps ? ' table__cell--over' : ''}`}>
            {steps} / {maxSteps ?? '—'}
          </dd>
        </div>
        <div className="table__col">
          <dt className="table__head">Tokens</dt>
          <dd className="table__cell">
            {state.usage.inputTokens + state.usage.outputTokens === 0
              ? '—'
              : `${formatCount(state.usage.inputTokens)} in · ${formatCount(state.usage.outputTokens)} out`}
          </dd>
        </div>
        <div className="table__col">
          <dt className="table__head">Est. cost</dt>
          <dd className="table__cell">{formatCost(state)}</dd>
        </div>
      </dl>

      {maxSteps !== undefined && (
        <p className={`budget${overSteps ? ' budget--over' : ''}`}>
          <Meter value={steps} max={maxSteps} label="Steps used against the budget" />
          <span className="budget__note">step budget</span>
        </p>
      )}
    </section>
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
