import { MAX_QUERY_LENGTH } from '@ara/shared';
import { useState, type JSX, type SubmitEventHandler } from 'react';

/** The recorded one first, so a demo with no network still has something to show. */
const EXAMPLES: readonly string[] = [
  'Why is the sky blue?',
  'How much faster is HTTP/3 than HTTP/2?',
  'What did the last CPython release change about the GIL?',
];

export interface ComposerProps {
  readonly busy: boolean;
  readonly onSubmit: (query: string) => void;
}

export function Composer({ busy, onSubmit }: ComposerProps): JSX.Element {
  const [query, setQuery] = useState('');

  const submit: SubmitEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length >= 3 && !busy) onSubmit(trimmed);
  };

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer__row">
        <label className="composer__input-wrap" htmlFor="query" hidden>
          Your research question
        </label>
        <input
          id="query"
          className="composer__input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder="Ask a research question"
          maxLength={MAX_QUERY_LENGTH}
          disabled={busy}
          autoComplete="off"
        />
        <button
          className="composer__submit"
          type="submit"
          disabled={busy || query.trim().length < 3}
        >
          {busy ? 'Working' : 'Ask'}
        </button>
      </div>

      <div className="chips">
        <span className="chips__label" id="examples-label">
          Try
        </span>
        {EXAMPLES.map((example) => (
          <button
            key={example}
            className="chip"
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
        ))}
      </div>
    </form>
  );
}
