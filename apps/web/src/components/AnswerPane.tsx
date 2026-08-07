import type { CitationGrounding, RunWarning, VerifiedCitation } from '@ara/shared';
import { Fragment, type JSX, type ReactNode } from 'react';

import { ICON } from './Glyphs.tsx';

export interface AnswerPaneProps {
  readonly answer: string;
  readonly citations: readonly VerifiedCitation[];
  readonly warnings: readonly RunWarning[];
}

interface GroundingStyle {
  readonly label: string;
  readonly detail: string;
  /** DESIGN.md §7. Colour carries severity; the glyph carries which check failed. */
  readonly icon: string;
  readonly tone: 'ok' | 'quiet' | 'bad';
}

/**
 * How each grounding verdict is put to the reader.
 *
 * The label is the short form next to the source; the explanation is what the
 * reader gets on hover, and it says what was checked rather than how confident
 * anyone is. `quoted` is labelled too — a badge that appears only on failure
 * teaches people that no badge means unchecked, which is the opposite of true.
 *
 * The two failures share a tone and differ in mark, because they are different
 * failures: `!` is a claim that did not hold against a source that is real, `✗`
 * is a source that never appeared in the run at all.
 */
const GROUNDING: Record<CitationGrounding, GroundingStyle> = {
  quoted: {
    label: 'Quoted',
    detail: 'This page was fetched, and the quoted sentence appears in the text it served.',
    icon: ICON.success,
    tone: 'ok',
  },
  snippet: {
    label: 'Snippet only',
    detail:
      'The quoted sentence appears in a search result for this URL, but the page itself was ' +
      'never fetched — the words are the search engine describing the source rather than the ' +
      'source.',
    icon: ICON.info,
    tone: 'quiet',
  },
  unsupported: {
    label: 'Quote not found',
    detail:
      'A tool returned this URL, but the quoted sentence does not appear in what it returned. ' +
      'The source is real; the words attributed to it are not.',
    icon: ICON.warning,
    tone: 'bad',
  },
  url_only: {
    label: 'Source only',
    detail:
      'A tool returned this URL, but no quote was offered — the source was checked and the ' +
      'claim was not.',
    icon: ICON.pending,
    tone: 'quiet',
  },
  unobserved: {
    label: 'Unverified',
    detail: 'No tool returned this URL during the run.',
    icon: ICON.error,
    tone: 'bad',
  },
};

export function AnswerPane({ answer, citations, warnings }: AnswerPaneProps): JSX.Element {
  const byId = new Map(citations.map((citation) => [citation.id, citation]));

  return (
    <div className="panel">
      <h2 className="panel__legend">Answer</h2>

      {/* Paragraphs have no identity beyond their position, so position is the key. */}
      {answer.split(/\n{2,}/u).map((paragraph, index) => (
        <p className="prose" key={index}>
          {linkCitations(paragraph, byId)}
        </p>
      ))}

      {citations.length > 0 && (
        <>
          <h3 className="panel__heading">Sources</h3>
          <ul className="sources" aria-label="Sources">
            {citations.map((citation) => (
              <Source citation={citation} key={citation.id} />
            ))}
          </ul>
        </>
      )}

      {warnings.length > 0 && <Warnings warnings={warnings} />}
    </div>
  );
}

function Source({ citation }: { readonly citation: VerifiedCitation }): JSX.Element {
  const { label, detail, icon, tone } = GROUNDING[citation.grounding];

  return (
    <li className={`source source--${citation.grounding} source--${tone}`}>
      <div className="source__head">
        <span className="source__mark" aria-hidden="true">
          {icon}
        </span>
        <span className="source__id">[{citation.id}]</span>
        <a className="source__link" href={citation.url} target="_blank" rel="noreferrer noopener">
          {citation.title}
        </a>
        <span className="source__flag" title={detail}>
          {label}
        </span>
      </div>

      <Grounding citation={citation} />
    </li>
  );
}

/**
 * The evidence under a source, when there is any to show.
 *
 * A matched quote is shown as the *source's* text with the match highlighted, not
 * as the model's copy of it — the whole claim being made is "these words are in
 * that page", so the page's words are what belongs on screen. A quote that failed
 * is shown as the model wrote it, since that is the thing that was wrong.
 */
function Grounding({ citation }: { readonly citation: VerifiedCitation }): JSX.Element | null {
  const matched = citation.grounding === 'quoted' || citation.grounding === 'snippet';

  if (matched && citation.quoteMatch !== undefined) {
    const { before, match, after } = citation.quoteMatch;
    return (
      <blockquote className={`evidence evidence--${citation.grounding}`}>
        {before}
        <mark className="evidence__match">{match}</mark>
        {after}
        {citation.grounding === 'snippet' && (
          <span className="evidence__note">from the search result, not the page</span>
        )}
      </blockquote>
    );
  }

  if (citation.grounding === 'unsupported' && citation.quote !== undefined) {
    return (
      <blockquote className="evidence evidence--unsupported">
        <span className="evidence__struck">{citation.quote}</span>
        <span className="evidence__note">not found in this source</span>
      </blockquote>
    );
  }

  return null;
}

export function Warnings({ warnings }: { readonly warnings: readonly RunWarning[] }): JSX.Element {
  return (
    <div className="warnings">
      <strong className="warnings__title">
        <span className="warnings__mark" aria-hidden="true">
          {ICON.warning}
        </span>
        The run flagged {warnings.length === 1 ? 'an issue' : 'some issues'}
      </strong>
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
 * nothing — the citation check has already decided what each source is worth, and
 * this function's job is to display that decision, not to second-guess it.
 */
function linkCitations(text: string, byId: ReadonlyMap<number, VerifiedCitation>): ReactNode[] {
  return text.split(/(\[\d+\])/u).map((part, index) => {
    const marker = /^\[(\d+)\]$/u.exec(part);
    const citation = marker?.[1] === undefined ? undefined : byId.get(Number(marker[1]));

    if (citation === undefined) return <Fragment key={index}>{part}</Fragment>;

    return (
      <a
        key={index}
        className={`citation citation--${citation.grounding}`}
        href={citation.url}
        target="_blank"
        rel="noreferrer noopener"
        title={`${citation.title} — ${GROUNDING[citation.grounding].label.toLowerCase()}`}
      >
        {part}
      </a>
    );
  });
}
