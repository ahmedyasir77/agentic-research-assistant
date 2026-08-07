import type { JsonValue } from '@ara/shared';
import type { JSX } from 'react';

import type { ToolCallView } from '../lib/runReducer.ts';
import { ICON, Spinner } from './Glyphs.tsx';

export interface ToolCallProps {
  readonly call: ToolCallView;
}

/**
 * One tool call, collapsed to a single terminal line and expandable to exactly
 * what crossed the wire. A native `<details>` because the disclosure behaviour,
 * the keyboard handling and the screen-reader semantics are all already correct —
 * and because DESIGN.md's list marker, `▸`, is the disclosure triangle anyway.
 *
 * The status mark is a character (`✓`, `✗`, or the braille spinner) and never
 * colour alone, so the three states are still three states in monochrome.
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
        <Status status={call.status} />
      </summary>

      {call.errorMessage !== undefined && <p className="call__error">{call.errorMessage}</p>}

      <Payload label="Arguments" value={call.args} />
      {call.output !== undefined && <Payload label="Result" value={call.output} />}
    </details>
  );
}

function Status({ status }: { readonly status: ToolCallView['status'] }): JSX.Element {
  if (status === 'running') return <Spinner />;

  return (
    <span className="call__status" aria-hidden="true">
      {status === 'ok' ? ICON.success : ICON.error}
    </span>
  );
}

/**
 * Wraps rather than scrolls sideways. `finish` serialises a whole prose answer
 * into one JSON string, so `white-space: pre` made reading it a horizontal drag
 * across several screens — see ADR-035 for the second bug of that shape.
 */
function Payload({
  label,
  value,
}: {
  readonly label: string;
  readonly value: JsonValue;
}): JSX.Element {
  return (
    <div className="payload">
      <span className="payload__label">{label}</span>
      <pre className="payload__body">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

/** The one-line version: enough to recognise the call without opening it. */
function summarise(args: JsonValue): string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return JSON.stringify(args);
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('  ·  ');
}
