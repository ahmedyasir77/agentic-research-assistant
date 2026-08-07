import type { JSX, ReactNode } from 'react';

import { AnswerPane } from './components/AnswerPane.tsx';
import { Composer } from './components/Composer.tsx';
import { Counters } from './components/Counters.tsx';
import { ICON, SECTION_BREAK } from './components/Glyphs.tsx';
import { Masthead } from './components/Masthead.tsx';
import { RunFailure } from './components/RunFailure.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Timeline } from './components/Timeline.tsx';
import { useRunStream } from './hooks/useRunStream.ts';
import { isRunning } from './lib/runReducer.ts';
import './styles/app.css';

/**
 * One screen: ask, then watch, with a status line pinned to the bottom the way
 * DESIGN.md §5 pins one. The whole run lives in `useRunStream`, so this file is
 * only ever deciding what to show — which is why it reads top to bottom in the
 * order the user experiences it.
 */
export function App(): JSX.Element {
  const { state, start } = useRunStream();
  const live = isRunning(state);

  return (
    <div className="screen">
      <Masthead />

      <main className="app">
        <Composer busy={live} onSubmit={start} />

        {state.phase === 'idle' ? (
          <section className="idle">
            <p className="rule" aria-hidden="true">
              {SECTION_BREAK}
            </p>
            <p className="prose prose--quiet">
              Ask a question and the agent will plan, call its tools, and answer with sources it
              actually read.
            </p>
          </section>
        ) : (
          <>
            <Counters state={state} />

            <section className="trace">
              <Timeline steps={state.steps} live={live} />

              {state.failure !== undefined && (
                <Terminus failed>
                  <RunFailure failure={state.failure} warnings={state.warnings} />
                </Terminus>
              )}

              {state.phase === 'completed' && (
                <Terminus>
                  <AnswerPane
                    answer={state.answer}
                    citations={state.citations}
                    warnings={state.warnings}
                  />
                </Terminus>
              )}
            </section>
          </>
        )}

        {state.clientError !== undefined && (
          <p className="notice" role="alert">
            <span className="notice__mark" aria-hidden="true">
              {ICON.error}
            </span>
            {state.clientError}
          </p>
        )}
      </main>

      <StatusBar state={state} />
    </div>
  );
}

/**
 * Where the trace stops. Same two-column grid as a timeline step, so the elbow
 * that closes the rail is drawn by the same rule that draws every branch above
 * it — the panel's own top border is what it meets.
 */
function Terminus({
  failed = false,
  children,
}: {
  readonly failed?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className={`node node--terminal${failed ? ' node--failed' : ''}`}>
      <span className="node__gutter" aria-hidden="true" />
      <div className="node__body">{children}</div>
    </div>
  );
}
