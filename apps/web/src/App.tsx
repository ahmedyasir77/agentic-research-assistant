import type { JSX } from 'react';

import { AnswerPane } from './components/AnswerPane.tsx';
import { Composer } from './components/Composer.tsx';
import { Counters } from './components/Counters.tsx';
import { ModeBadge } from './components/ModeBadge.tsx';
import { RunFailure } from './components/RunFailure.tsx';
import { Timeline } from './components/Timeline.tsx';
import { useRunStream } from './hooks/useRunStream.ts';
import { isRunning } from './lib/runReducer.ts';
import './styles/app.css';

/**
 * One page: ask, then watch. The whole run lives in `useRunStream`, so this file
 * is only ever deciding what to show — which is why it reads top to bottom in the
 * order the user experiences it.
 */
export function App(): JSX.Element {
  const { state, start } = useRunStream();
  const live = isRunning(state);

  return (
    <main className="app">
      <header className="masthead">
        <h1 className="masthead__title">Agentic research assistant</h1>
        <ModeBadge />
      </header>

      <Composer busy={live} onSubmit={start} />

      {state.phase === 'idle' ? (
        <p className="empty">
          Ask a question and the agent will plan, call its tools, and answer with sources it
          actually read.
        </p>
      ) : (
        <>
          <Counters state={state} />

          <section className="trace">
            <Timeline steps={state.steps} live={live} />

            {state.failure !== undefined && (
              <div className="node node--terminal node--failed">
                <RunFailure failure={state.failure} warnings={state.warnings} />
              </div>
            )}

            {state.phase === 'completed' && (
              <div className="node node--terminal">
                <AnswerPane
                  answer={state.answer}
                  citations={state.citations}
                  warnings={state.warnings}
                />
              </div>
            )}
          </section>
        </>
      )}

      {state.clientError !== undefined && (
        <p className="notice" role="alert">
          {state.clientError}
        </p>
      )}
    </main>
  );
}
