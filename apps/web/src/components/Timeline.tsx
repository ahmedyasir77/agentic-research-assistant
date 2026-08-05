import type { JSX } from 'react';

import type { StepView } from '../lib/runReducer.ts';
import { ToolCall } from './ToolCall.tsx';

export interface TimelineProps {
  readonly steps: readonly StepView[];
  /** True while the agent is still working, which is what leaves the trace open-ended. */
  readonly live: boolean;
}

/**
 * The signature element: one node per step, hung off a single continuous trace.
 * The last node's segment fades out while the run is going, so the line visibly
 * ends in mid-air — the run's own progress bar, with no animation to respect or
 * ignore.
 */
export function Timeline({ steps, live }: TimelineProps): JSX.Element {
  return (
    <ol className="timeline" aria-label="Agent steps" aria-live="polite" aria-relevant="additions">
      {steps.map((step, position) => (
        <li
          key={step.index}
          className={`node${live && position === steps.length - 1 ? ' node--live' : ''}`}
        >
          <h2 className="node__head">
            <span>Step {String(step.index + 1).padStart(2, '0')}</span>
          </h2>

          {step.text !== '' && <p className="prose">{step.text}</p>}

          {step.toolCalls.length > 0 && (
            <div className="calls">
              {step.toolCalls.map((call) => (
                <ToolCall key={call.callId} call={call} />
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
