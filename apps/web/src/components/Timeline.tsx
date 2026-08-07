import type { JSX } from 'react';

import type { StepView } from '../lib/runReducer.ts';
import { Thinking } from './Glyphs.tsx';
import { ToolCall } from './ToolCall.tsx';

export interface TimelineProps {
  readonly steps: readonly StepView[];
  /** True while the agent is still working, which is what leaves the trace open-ended. */
  readonly live: boolean;
}

/**
 * The signature element, redrawn as a terminal tree: one branch per step hung off
 * a single rail, each branch headed by a rule that runs out to the right margin.
 *
 * Every rail and arm is a one-pixel CSS rule rather than a `│` or `├` character.
 * At this size the two are indistinguishable — but a character has to be aligned
 * to a junction it cannot measure, and a rule can be told to meet one exactly.
 * The characters are kept for the things that stand alone: status marks, the
 * spinner, the progress bar. See `.node` in app.css for how the junction is
 * pinned to the middle of the head's first line.
 *
 * The last node's rail fades out while the run is going, so the trace visibly ends
 * in mid-air — the run's own progress bar, with no animation to respect or ignore.
 */
export function Timeline({ steps, live }: TimelineProps): JSX.Element {
  return (
    <ol className="timeline" aria-label="Agent steps" aria-live="polite" aria-relevant="additions">
      {steps.map((step, position) => {
        const last = position === steps.length - 1;
        const calls = step.toolCalls.length;
        // Between calls, or after the last one, the agent is composing rather than
        // waiting on a tool — which looks identical to being stuck unless it says so.
        const thinking = live && last && !step.toolCalls.some((call) => call.status === 'running');

        return (
          <li key={step.index} className={`node${live && last ? ' node--live' : ''}`}>
            <span className="node__gutter" aria-hidden="true" />

            <h2 className="node__head">
              <span className="node__label">Step {String(step.index + 1).padStart(2, '0')}</span>
              <span className="node__fill" aria-hidden="true" />
              {calls > 0 && (
                <span className="node__meta">
                  {calls} {calls === 1 ? 'call' : 'calls'}
                </span>
              )}
            </h2>

            <span className="node__rail" aria-hidden="true" />

            <div className="node__body">
              {step.text !== '' && <p className="prose">{step.text}</p>}

              {calls > 0 && (
                <div className="calls">
                  {step.toolCalls.map((call) => (
                    <ToolCall key={call.callId} call={call} />
                  ))}
                </div>
              )}

              {thinking && (
                <p className="thinking">
                  <Thinking />
                  thinking
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
