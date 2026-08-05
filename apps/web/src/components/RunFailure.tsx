import type { RunFailureReason, RunWarning } from '@ara/shared';
import type { JSX } from 'react';

import type { RunFailureView } from '../lib/runReducer.ts';
import { Warnings } from './AnswerPane.tsx';

/**
 * A stopped run is a result, not an accident, so it gets the same panel the answer
 * gets rather than a toast that fades. A budget-exceeded run in particular should
 * look like the rails working — because that is what happened.
 */
const HEADINGS: Readonly<Record<RunFailureReason, string>> = {
  budget_exceeded: 'Stopped at its budget',
  no_tool_call: 'Stopped without an answer',
  llm_error: 'The model could not be reached',
  internal_error: 'Something broke on our side',
};

const NEXT_STEPS: Readonly<Record<RunFailureReason, string>> = {
  budget_exceeded:
    'The agent ran out of steps or time before it called finish. Ask a narrower question, or raise MAX_STEPS.',
  no_tool_call:
    'The model kept answering in prose instead of calling finish, so the run was stopped rather than looped. Try rephrasing the question.',
  llm_error: 'This is usually transient. Ask again in a moment.',
  internal_error:
    'The failure has been logged. Ask again, and if it persists the run id above is the one to quote.',
};

export interface RunFailureProps {
  readonly failure: RunFailureView;
  readonly warnings: readonly RunWarning[];
}

export function RunFailure({ failure, warnings }: RunFailureProps): JSX.Element {
  return (
    <div className="panel panel--failed">
      <h2 className="panel__title">{HEADINGS[failure.reason]}</h2>
      <p className="prose">{failure.message}</p>
      <p className="prose">{NEXT_STEPS[failure.reason]}</p>

      {failure.partialAnswer !== undefined && (
        <>
          <h3 className="panel__title">What it had so far</h3>
          <p className="prose">{failure.partialAnswer}</p>
        </>
      )}

      {warnings.length > 0 && <Warnings warnings={warnings} />}
    </div>
  );
}
