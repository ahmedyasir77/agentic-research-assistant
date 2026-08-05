import type { RunWarning, VerifiedCitation } from '@ara/shared';
import { Fragment, type JSX, type ReactNode } from 'react';

export interface AnswerPaneProps {
  readonly answer: string;
  readonly citations: readonly VerifiedCitation[];
  readonly warnings: readonly RunWarning[];
}

export function AnswerPane({ answer, citations, warnings }: AnswerPaneProps): JSX.Element {
  const byId = new Map(citations.map((citation) => [citation.id, citation]));

  return (
    <div className="panel">
      <h2 className="panel__title">Answer</h2>

      {/* Paragraphs have no identity beyond their position, so position is the key. */}
      {answer.split(/\n{2,}/u).map((paragraph, index) => (
        <p className="prose" key={index}>
          {linkCitations(paragraph, byId)}
        </p>
      ))}

      {citations.length > 0 && (
        <ul className="sources" aria-label="Sources">
          {citations.map((citation) => (
            <li
              key={citation.id}
              className={`source${citation.verified ? '' : ' source--unverified'}`}
            >
              <span className="source__id">[{citation.id}]</span>
              <a
                className="source__link"
                href={citation.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {citation.title}
              </a>
              {!citation.verified && (
                <span className="source__flag" title="No tool returned this URL during the run.">
                  Unverified
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {warnings.length > 0 && <Warnings warnings={warnings} />}
    </div>
  );
}

export function Warnings({ warnings }: { readonly warnings: readonly RunWarning[] }): JSX.Element {
  return (
    <div className="warnings">
      <strong>The run flagged {warnings.length === 1 ? 'an issue' : 'some issues'}</strong>
      <ul className="warnings__list">
        {warnings.map((warning) => (
          <li key={`${warning.kind}:${warning.message}`}>{warning.message}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Turns the `[1]` markers the model wrote into links to the source they name.
 *
 * A marker with no matching citation is left as plain text rather than linked to
 * nothing — the citation check has already decided which sources are real, and this
 * function's job is to display that decision, not to second-guess it.
 */
function linkCitations(text: string, byId: ReadonlyMap<number, VerifiedCitation>): ReactNode[] {
  return text.split(/(\[\d+\])/u).map((part, index) => {
    const marker = /^\[(\d+)\]$/u.exec(part);
    const citation = marker?.[1] === undefined ? undefined : byId.get(Number(marker[1]));

    if (citation === undefined) return <Fragment key={index}>{part}</Fragment>;

    return (
      <a
        key={index}
        className={`citation${citation.verified ? '' : ' citation--unverified'}`}
        href={citation.url}
        target="_blank"
        rel="noreferrer noopener"
        title={citation.verified ? citation.title : `${citation.title} — unverified`}
      >
        {part}
      </a>
    );
  });
}
