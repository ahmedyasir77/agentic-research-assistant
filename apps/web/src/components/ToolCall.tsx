import type { JsonValue } from '@ara/shared';
import type { JSX } from 'react';

import type { ToolCallView } from '../lib/runReducer.ts';

export interface ToolCallProps {
  readonly call: ToolCallView;
}

/**
 * One tool call, collapsed to a line and expandable to exactly what crossed the
 * wire. A native `<details>` because the disclosure behaviour, the keyboard
 * handling and the screen-reader semantics are all already correct.
 */
export function ToolCall({ call }: ToolCallProps): JSX.Element {
  return (
    <details className={`call call--${call.status}`}>
      <summary className="call__summary">
        <span className="call__name">{call.tool}</span>
        <span className="call__args">{summarise(call.args)}</span>
        <span className="call__timing">
          {call.status === 'running' ? 'running' : `${String(Math.round(call.durationMs ?? 0))}ms`}
        </span>
      </summary>

      {call.errorMessage !== undefined && <p className="call__error">{call.errorMessage}</p>}

      <pre className="payload">
        <span className="payload__label">Arguments</span>
        {JSON.stringify(call.args, null, 2)}
      </pre>

      {call.output !== undefined && (
        <pre className="payload">
          <span className="payload__label">Result</span>
          {JSON.stringify(call.output, null, 2)}
        </pre>
      )}
    </details>
  );
}

/** The one-line version: enough to recognise the call without opening it. */
function summarise(args: JsonValue): string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return JSON.stringify(args);
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('  ·  ');
}
