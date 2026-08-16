import { MAX_QUERY_LENGTH } from '@ara/shared';
import { useState, type JSX, type SubmitEventHandler } from 'react';

import { ICON, Spinner } from './Glyphs.tsx';

/**
 * The recorded ones first, so a demo with no network still has something to show.
 * The second is recorded too, and is the run where the grounding check catches a
 * real source quoted for a sentence it never contained.
 */
const EXAMPLES: readonly string[] = [
  'Why is the sky blue?',
  'How much more is blue light scattered than red?',
  'How much faster is HTTP/3 than HTTP/2?',
  'What did the last CPython release change about the GIL?',
];

export interface ComposerProps {
  readonly busy: boolean;
  readonly onSubmit: (query: string) => void;
  readonly onCancel: () => void;
}

/**
 * DESIGN.md §5 — a bordered input that takes the Accent border when it is active,
 * a reverse-video submit, and the examples as a menu rather than a row of pills.
 *
 * The `▸` on the prompt and on the hovered menu item are drawn in CSS, not in the
 * markup. That is not a stylistic preference: a glyph in the markup would end up
 * inside the button's accessible name, so the submit would announce as "▸ Ask"
 * and an example would announce with a selector character it does not have.
 */
export function Composer({ busy, onSubmit, onCancel }: ComposerProps): JSX.Element {
  const [query, setQuery] = useState('');

  const submit: SubmitEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length >= 3 && !busy) onSubmit(trimmed);
  };

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer__row">
        <label className="sr-only" htmlFor="query">
          Your research question
        </label>

        <div className={`field${busy ? ' field--busy' : ''}`}>
          <span className="field__prompt" aria-hidden="true">
            {ICON.selected}
          </span>
          <input
            id="query"
            className="field__input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="Ask a research question"
            maxLength={MAX_QUERY_LENGTH}
            disabled={busy}
            autoComplete="off"
          />
          {/* Only once there is something to count — "0/500" at rest is noise. */}
          {query.length > 0 && (
            <span className="field__count" aria-hidden="true">
              {query.length}/{MAX_QUERY_LENGTH}
            </span>
          )}
        </div>

        <button className="button" type="submit" disabled={busy || query.trim().length < 3}>
          {busy && <Spinner />}
          {busy ? 'Working' : 'Ask'}
        </button>

        {/* DESIGN.md §5 — "▸ Submit    Cancel" is a plain-text action beside the
            primary one, not a second bordered button. Only present once there is a
            run to stop, so idle and completed states are back to one button. */}
        {busy && (
          <button className="button button--ghost" type="button" onClick={onCancel}>
            Stop
          </button>
        )}
      </div>

      <div className="examples">
        <span className="label" id="examples-label">
          Try
        </span>
        <ul className="menu">
          {EXAMPLES.map((example) => (
            <li key={example}>
              <button
                className="menu__item"
                type="button"
                disabled={busy}
                aria-describedby="examples-label"
                onClick={() => {
                  setQuery(example);
                  onSubmit(example);
                }}
              >
                {example}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </form>
  );
}
