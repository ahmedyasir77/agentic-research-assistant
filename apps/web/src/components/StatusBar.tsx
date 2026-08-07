import type { JSX } from 'react';

import type { RunState } from '../lib/runReducer.ts';
import { ICON, Spinner } from './Glyphs.tsx';
import { ModeBadge } from './ModeBadge.tsx';

export interface StatusBarProps {
  readonly state: RunState;
}

/**
 * DESIGN.md §5 — one line pinned to the bottom: left-aligned info, right-aligned
 * status, items separated by ` ─ `.
 *
 * It says what the run is doing now, which is the question the rest of the page
 * answers only by making you read it. Not a live region: the timeline above
 * already announces its own additions, and two things narrating the same run is
 * worse than one.
 */
export function StatusBar({ state }: StatusBarProps): JSX.Element {
  const steps = state.steps.length;

  return (
    <footer className="statusbar">
      <div className="statusbar__side">
        <Phase state={state} />

        {/* Grouped rather than laid out flat so a narrow screen can drop the lot in
            one rule. Measured at 420px: left to itself the run id pushed the mode
            badge clean off the viewport, and because the bar is fixed it went
            without widening the document or showing a scrollbar. The mode badge is
            the one thing ADR-025 says is worth pointing at, so it is what stays. */}
        <span className="statusbar__details">
          {state.runId !== undefined && (
            <>
              <Sep />
              <span className="statusbar__item">{state.runId}</span>
            </>
          )}

          {steps > 0 && (
            <>
              <Sep />
              <span className="statusbar__item">
                {steps} {steps === 1 ? 'step' : 'steps'}
              </span>
            </>
          )}

          {state.durationMs !== undefined && (
            <>
              <Sep />
              <span className="statusbar__item">{(state.durationMs / 1000).toFixed(1)}s</span>
            </>
          )}
        </span>
      </div>

      <div className="statusbar__side statusbar__side--right">
        <ModeBadge />
      </div>
    </footer>
  );
}

function Sep(): JSX.Element {
  return (
    <span className="statusbar__sep" aria-hidden="true">
      ─
    </span>
  );
}

function Phase({ state }: StatusBarProps): JSX.Element {
  switch (state.phase) {
    case 'idle':
      return (
        <span className="statusbar__phase">
          <span className="statusbar__icon">{ICON.pending}</span> ready
        </span>
      );
    case 'starting':
      return (
        <span className="statusbar__phase statusbar__phase--live">
          <Spinner /> connecting
        </span>
      );
    case 'running':
      return (
        <span className="statusbar__phase statusbar__phase--live">
          <Spinner /> running
        </span>
      );
    case 'completed':
      return (
        <span className="statusbar__phase statusbar__phase--ok">
          <span className="statusbar__icon">{ICON.success}</span> completed
        </span>
      );
    case 'failed':
      return (
        <span className="statusbar__phase statusbar__phase--bad">
          <span className="statusbar__icon">{ICON.error}</span> stopped
        </span>
      );
  }
}
