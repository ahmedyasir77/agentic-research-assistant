import type { Citation, JsonValue, RunWarning, VerifiedCitation } from '@ara/shared';

/**
 * The anti-hallucination check.
 *
 * A model asked for sources will sometimes produce a URL that looks exactly right
 * and was never returned by anything — the failure is invisible precisely because
 * the citation is plausible. So every URL in the `finish` payload is cross-checked
 * against the set of URLs tools actually returned during this run. Anything that
 * cannot be accounted for is marked unverified and surfaced as a warning.
 *
 * Unverified citations are kept rather than deleted: showing that the agent
 * claimed a source and the check caught it is more useful — and more honest —
 * than quietly shortening the list.
 */
export interface CitationReview {
  readonly citations: readonly VerifiedCitation[];
  readonly warnings: readonly RunWarning[];
}

export function reviewCitations(
  claimed: readonly Citation[],
  observed: ReadonlySet<string>,
): CitationReview {
  const normalisedObserved = new Set([...observed].map(normaliseUrl));

  const citations = claimed.map((citation) => ({
    ...citation,
    verified: normalisedObserved.has(normaliseUrl(citation.url)),
  }));

  const warnings = citations
    .filter((citation) => !citation.verified)
    .map((citation): RunWarning => ({
      kind: 'unverified_citation',
      message: `Citation [${String(citation.id)}] cites ${citation.url}, which no tool returned during this run.`,
    }));

  return { citations, warnings };
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
 * Walks a tool result and collects every http(s) URL in it, wherever it appears.
 * Shape-agnostic on purpose: a new tool that returns URLs in a field nobody
 * anticipated still feeds the citation check without anyone remembering to wire
 * it up.
 */
export function collectUrls(value: JsonValue, into: Set<string>): void {
  if (typeof value === 'string') {
    if (/^https?:\/\//iu.test(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectUrls(child, into);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) collectUrls(child, into);
  }
}
