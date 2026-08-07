import type { Citation, JsonValue, QuoteMatch, RunWarning, VerifiedCitation } from '@ara/shared';

import type { ToolEvidence } from '../tools/types.ts';

/**
 * The anti-hallucination check, in three rungs.
 *
 * The first rung is the URL. A model asked for sources will sometimes produce one
 * that looks exactly right and was never returned by anything — the failure is
 * invisible precisely because the citation is plausible. So every URL in the
 * `finish` payload is cross-checked against the URLs tools actually returned.
 *
 * The second rung is the quote, and it is the one that matters. A URL check cannot
 * tell the difference between a source that says what the agent claims and a real
 * source stapled to a sentence it never contained — the citation is honest about
 * *where* it came from and silent about *whether the source says it*. So `finish`
 * asks for the supporting sentence too, and that sentence is matched against the
 * text that URL actually returned. A paraphrase does not match, which is the point:
 * the agent has to point at words that exist.
 *
 * The third rung is where that text came from. A search snippet and a page body are
 * both strings attached to a URL, and an agent can satisfy the quote check without
 * ever reading the source by quoting the search engine's summary of it. That is a
 * real citation to a real page and still not a reading of it, so matched text is
 * kept with the provenance the tool declared, and a quote found only in a snippet
 * is labelled `snippet` rather than `quoted`.
 *
 * Nothing that fails is deleted. A citation the check caught is kept, labelled, and
 * shown — the failure is the most informative thing on the screen, and a quietly
 * shortened source list would hide it.
 */

/** Text short enough to match by accident is not evidence, however real it is. */
const MIN_QUOTE_CHARS = 24;

/** Words either side of a match, so the quote can be read in context. */
const CONTEXT_CHARS = 90;

/** As much of a failing quote as belongs in a one-line warning. */
const WARNING_QUOTE_CHARS = 80;

/**
 * The quote itself, trimmed to fit in a warning.
 *
 * Nothing else in the message distinguishes one failure from another. The same
 * source cited for several claims is several citations sharing an id and a URL, so
 * a message built from those two alone renders every one of them as the identical
 * sentence — a run that failed eight different quotes reported the same line eight
 * times, which said there was a problem and hid what it was.
 */
function shorten(quote: string): string {
  const shown =
    quote.length <= WARNING_QUOTE_CHARS ? quote : `${quote.slice(0, WARNING_QUOTE_CHARS)}…`;
  return `“${shown}”`;
}

/**
 * Where a piece of matched text came from. `none` is excluded because a tool that
 * is not evidence about a URL contributes no segments to match against.
 */
export type EvidenceProvenance = Exclude<ToolEvidence, 'none'>;

/**
 * One independently attributed string, kept whole.
 *
 * Segments are stored apart rather than joined, so a title and a snippet can never
 * be read as one sentence neither of them contained. The boundary a quote cannot
 * cross is now the absence of any string spanning it, rather than a delimiter that
 * held only because normalisation stripped control characters.
 */
export interface EvidenceSegment {
  readonly text: string;
  readonly provenance: EvidenceProvenance;
}

/** Everything the run's tools returned, indexed by the URL they returned it for. */
export interface Evidence {
  /** Every http(s) URL any tool returned, normalised. */
  readonly urls: Set<string>;
  /** Normalised URL → each text returned for it, normalised, with its provenance. */
  readonly textByUrl: Map<string, EvidenceSegment[]>;
}

export function createEvidence(): Evidence {
  return { urls: new Set(), textByUrl: new Map() };
}

export interface CitationReview {
  readonly citations: readonly VerifiedCitation[];
  readonly warnings: readonly RunWarning[];
}

export function reviewCitations(claimed: readonly Citation[], evidence: Evidence): CitationReview {
  const reviewed = claimed.map((citation) => review(citation, evidence));

  return {
    citations: reviewed.map((entry) => entry.citation),
    warnings: reviewed.flatMap((entry) => (entry.warning === undefined ? [] : [entry.warning])),
  };
}

/**
 * Whether an answer cites sources without any of them having been read.
 *
 * The case this exists for: every quote checks out against a search snippet and
 * none against a page, which means the run answered from the search engine's
 * summaries and never opened a source. That is not a false citation — it is a
 * shallow one, and it is the one thing the agent can still fix while it has budget
 * left, which is why the loop asks rather than just labelling it.
 *
 * Narrow on purpose. An empty citation list is a question that needed no sources,
 * and a single `quoted` citation is enough to show the agent does read what it
 * cites, so neither is worth spending a step on.
 */
export function citesOnlyUnreadSources(claimed: readonly Citation[], evidence: Evidence): boolean {
  if (claimed.length === 0) return false;

  const { citations } = reviewCitations(claimed, evidence);
  return (
    citations.some((citation) => citation.grounding === 'snippet') &&
    !citations.some((citation) => citation.grounding === 'quoted')
  );
}

/**
 * The citations whose quotes did not hold up, so the loop can hand them back.
 *
 * The check runs in `complete`, which is after the answer is fixed and too late for
 * the agent to do anything — the failure reaches the user and never reaches the
 * model. This is the same verdict asked for early enough to be actionable: a quote
 * that is not in the page is usually a sentence recalled instead of copied, or one
 * below the cut of a truncated read, and both are things the agent can still fix
 * with a step and an `offset`.
 */
export function unsupportedCitations(
  claimed: readonly Citation[],
  evidence: Evidence,
): readonly VerifiedCitation[] {
  return reviewCitations(claimed, evidence).citations.filter(
    (citation) => citation.grounding === 'unsupported',
  );
}

interface ReviewedCitation {
  readonly citation: VerifiedCitation;
  readonly warning?: RunWarning;
}

function review(citation: Citation, evidence: Evidence): ReviewedCitation {
  const url = normaliseUrl(citation.url);

  if (!evidence.urls.has(url)) {
    return {
      citation: { ...citation, grounding: 'unobserved' },
      warning: {
        kind: 'unverified_citation',
        message: `Citation [${String(citation.id)}] cites ${citation.url}, which no tool returned during this run.`,
      },
    };
  }

  const quote = citation.quote === undefined ? '' : normaliseText(citation.quote);

  // No quote is a weaker citation, not a wrong one: the source is real and only the
  // claim is unchecked. The label says so; a warning would cry wolf.
  if (quote === '') return { citation: { ...citation, grounding: 'url_only' } };

  if (quote.length < MIN_QUOTE_CHARS) {
    return {
      citation: { ...citation, grounding: 'unsupported' },
      warning: {
        kind: 'unsupported_quote',
        message: `Citation [${String(citation.id)}] quotes only ${String(quote.length)} characters of ${citation.url}, which is too short to establish anything: ${shorten(quote)}.`,
      },
    };
  }

  const found = locate(evidence.textByUrl.get(url) ?? [], quote);
  if (found === undefined) {
    return {
      citation: { ...citation, grounding: 'unsupported' },
      warning: {
        kind: 'unsupported_quote',
        message: `Citation [${String(citation.id)}] attributes a quote to ${citation.url} that does not appear in what that source returned: ${shorten(quote)}.`,
      },
    };
  }

  if (found.provenance === 'snippet') {
    // Not a warning. The source is real, the words are real, and the agent has not
    // claimed anything false — it has only skipped reading the page. That is a
    // weaker rung, and warning on it would cry wolf the way warning on `url_only`
    // would.
    return { citation: { ...citation, grounding: 'snippet', quoteMatch: found.match } };
  }

  return { citation: { ...citation, grounding: 'quoted', quoteMatch: found.match } };
}

interface LocatedQuote {
  readonly match: QuoteMatch;
  readonly provenance: EvidenceProvenance;
}

/**
 * Finds the quote in one URL's evidence and returns the passage around it, with
 * where that passage came from.
 *
 * Fetched text is searched before snippets, so a sentence that appears in both is
 * credited to the page rather than to the summary of it — the strongest true label
 * wins. Matching is case-insensitive and segment-bounded. It is deliberately not
 * fuzzy: an approximate match would verify the paraphrases this check exists to
 * catch.
 */
function locate(segments: readonly EvidenceSegment[], quote: string): LocatedQuote | undefined {
  const needle = quote.toLowerCase();
  const byStrength = [
    ...segments.filter((segment) => segment.provenance === 'fetched'),
    ...segments.filter((segment) => segment.provenance === 'snippet'),
  ];

  for (const { text, provenance } of byStrength) {
    const index = text.toLowerCase().indexOf(needle);
    if (index === -1) continue;

    // Lowercasing is length-preserving for everything this will realistically see,
    // but not for every code point in Unicode. Where it is not, the match still
    // stands and only the offsets are untrustworthy — so the quote stands as its
    // own context rather than being shown a window sliced at the wrong place.
    if (text.toLowerCase().length !== text.length) {
      return { match: { before: '', match: quote, after: '' }, provenance };
    }

    return { match: windowAround(text, index, index + quote.length), provenance };
  }

  return undefined;
}

function windowAround(text: string, start: number, end: number): QuoteMatch {
  const from = Math.max(0, start - CONTEXT_CHARS);
  const to = Math.min(text.length, end + CONTEXT_CHARS);

  return {
    before: `${from > 0 ? '…' : ''}${text.slice(from, start)}`,
    match: text.slice(start, end),
    after: `${text.slice(end, to)}${to < text.length ? '…' : ''}`,
  };
}

/**
 * Compares URLs the way a person would: the host's capitalisation and a trailing
 * slash do not make it a different page, but a different query string does.
 * Deliberately conservative — a normaliser that is too clever verifies citations
 * that should have been caught.
 */
export function normaliseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.endsWith('/') && url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/u, '');
    }
    return url.toString();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/**
 * Puts text into the one form both sides of a quote comparison are held to.
 *
 * Everything here is a difference that is invisible on screen and fatal to an exact
 * match: a curly apostrophe copied out of rendered HTML, an em dash the model
 * retyped as a hyphen, a line break inside a sentence. Case is preserved, because
 * the matched passage is shown to the user — comparison lowercases both sides
 * instead. Nothing here changes which words are present, which is the line between
 * normalising and being lenient.
 */
export function normaliseText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/gu, "'")
    .replace(/[“”„‟″]/gu, '"')
    .replace(/[‐-―−]/gu, '-')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Walks a tool result collecting every rung's evidence at once: every http(s) URL,
 * and the text that came back with it, tagged with what the calling tool declared
 * that text to be worth.
 *
 * Attribution is by enclosing object. Strings belong to the nearest object above
 * them that carries a URL, so `{ results: [{ url, title, snippet }] }` files each
 * snippet under its own result and `{ finalUrl, textExcerpt }` files the excerpt
 * under the page it was read from. Shape-agnostic on purpose: a new tool that
 * returns URLs in a field nobody anticipated still feeds the check without anyone
 * remembering to wire it up.
 */
export function collectEvidence(
  value: JsonValue,
  into: Evidence,
  provenance: EvidenceProvenance,
): void {
  gather(value, [], into, provenance);
}

function gather(
  node: JsonValue,
  scope: readonly string[],
  into: Evidence,
  provenance: EvidenceProvenance,
): void {
  if (typeof node === 'string') {
    if (isHttpUrl(node)) {
      into.urls.add(normaliseUrl(node));
      return;
    }
    for (const url of scope) attribute(into, url, node, provenance);
    return;
  }

  if (Array.isArray(node)) {
    for (const child of node) gather(child, scope, into, provenance);
    return;
  }

  // Numbers, booleans and null carry no quotable text and no URL.
  if (typeof node !== 'object' || node === null) return;

  const values = Object.values(node);
  const own = values.filter(isHttpUrlValue).map(normaliseUrl);
  const inner = own.length > 0 ? own : scope;

  for (const child of values) gather(child, inner, into, provenance);
}

function attribute(
  into: Evidence,
  url: string,
  text: string,
  provenance: EvidenceProvenance,
): void {
  const cleaned = normaliseText(text);
  if (cleaned === '') return;

  const existing = into.textByUrl.get(url);
  const segment: EvidenceSegment = { text: cleaned, provenance };
  if (existing === undefined) {
    into.textByUrl.set(url, [segment]);
    return;
  }
  existing.push(segment);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function isHttpUrlValue(value: JsonValue): value is string {
  return typeof value === 'string' && isHttpUrl(value);
}
