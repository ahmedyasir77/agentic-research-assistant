import type { Citation } from '@ara/shared';

import type { FailedCitations } from './citations.ts';
import type { AgentPolicy } from './policy.ts';

/**
 * The system prompt. It is written for the model, so it is short, concrete and
 * free of the pleading that older models needed — telling a modern model something
 * is CRITICAL and it MUST do it mostly buys overtriggering.
 *
 * The tool descriptions live with the tools and are sent separately; this prompt
 * covers only what a tool description cannot: how to work, and what "done" means.
 */
export function buildSystemPrompt(policy: AgentPolicy): string {
  return [
    'You are a research assistant. You answer questions by finding sources, reading them, and',
    'reporting what they say — not by recalling what you already believe.',
    '',
    'How to work:',
    '- Search before answering when the answer depends on facts you would otherwise recall.',
    '- Read a promising source in full with http_get before citing it. A search snippet is a',
    '  reason to read a page, not evidence on its own.',
    '- A long page comes back in pieces. If a read says it was truncated, the sentence you want',
    '  may be below the cut — read on from nextOffset rather than concluding the page lacks it,',
    '  and never fill the gap from memory.',
    '- Use the calculator for arithmetic rather than doing it in your head.',
    '- Call several tools in one turn when the work is independent; they run in parallel.',
    '',
    'How to finish:',
    '- Call the finish tool. It is the only way to end a run — plain prose is not an answer,',
    '  and a turn without a tool call wastes a step.',
    '- This holds even when the question needed no research. Answer inside finish, with an empty',
    '  citations list, rather than replying directly.',
    '- Cite only URLs that appeared in a tool result during this run, copied out of that result',
    '  character for character. A URL is not something to reconstruct from a tool name, a search',
    '  query, or memory of where the page lives — citations are checked against what the tools',
    '  actually returned, and anything else is flagged as unverified.',
    '- Give every citation a quote: the sentence in that source which carries the claim, copied',
    '  exactly from the tool result. It is matched against that text character for character, so',
    '  copy rather than recall — a paraphrase is flagged as unsupported even when it is fair.',
    '- Take that sentence from the page you fetched with http_get, not from a search snippet. A',
    '  snippet is the search engine describing the page; quoting one is marked as a snippet',
    '  citation rather than a quoted one, because nothing read the source. If a snippet has what',
    '  you need, that is the signal to fetch the page and quote it properly.',
    '- If no sentence in a source supports the claim, that source does not support it. Read',
    '  another one, or say the sources do not settle it.',
    '- Mark each claim with its bracketed citation id, like [1].',
    '- Say plainly what the sources do not settle. An answer with a stated gap is worth more',
    '  than a confident one that papers over it.',
    '',
    'Your budget for this question:',
    `- ${String(policy.maxSteps)} steps, and ${String(Math.round(policy.maxWallClockMs / 1000))} seconds of wall clock.`,
    `- At most ${String(policy.maxToolCallsPerStep)} tool calls per step.`,
    '- Running out ends the run with whatever you have, so answer before you are cut off.',
    '',
    'If a tool call fails, read the error and adapt — a different query, a different source, a',
    'corrected argument. Repeating the same failing call wastes the budget.',
  ].join('\n');
}

/**
 * Sent when the model replies in prose instead of calling a tool. Phrased as a
 * correction the model can act on, and used at most `maxNudges` times before the
 * run gives up rather than looping.
 */
export const FINISH_NUDGE =
  'That turn contained no tool call, so it made no progress. If you can answer now, call the ' +
  'finish tool with your answer and citations. If you still need information, call a tool.';

/**
 * Sent when an answer's quotes all came from search snippets rather than from any
 * page.
 *
 * The instruction to read before citing is in the system prompt already, and on its
 * own it loses to arithmetic: a snippet containing the answer makes fetching pure
 * cost against a stated budget, so a model that ignores it is being rational rather
 * than careless. This is the same instruction arriving when it is the only way
 * forward, which is the version that changes behaviour. Bounded by the same nudge
 * budget as `FINISH_NUDGE` — one correction, then the run stands.
 */
export const SOURCE_NUDGE =
  'Every quote in those citations came from a search snippet, so nothing in this run has ' +
  'actually read the pages you cited — the snippets are the search engine describing them. ' +
  'Fetch the sources you want to cite with http_get, take each quote from the page text that ' +
  'comes back, and call finish again. Keep the answer you have; it is the evidence under it ' +
  'that needs to come from the sources themselves.';

/**
 * Sent when a `finish` call cites sources that did not survive the grounding check.
 *
 * This is the correction that was missing. The check ran only once the answer was
 * final, so the one party who could still fix a bad citation — the agent, with steps
 * and an `offset` argument left — was the only party never told. The failure went to
 * the user as a warning about a finished run instead.
 *
 * Both failures are reported in one message rather than one per turn. The nudge
 * budget is small and shared, and the agent has to reissue the whole `finish` payload
 * either way, so spending a turn on the fabricated URL and shipping the misquote —
 * or the reverse — fixes half the answer at full price.
 *
 * The failing citations are listed rather than merely counted, because the common
 * shape is one source cited for several claims: without the detail, every line names
 * the same id and the same URL and none of them says which one to go and fix.
 */
export function buildCitationNudge(failed: FailedCitations): string {
  return [
    ...(failed.unobserved.length === 0 ? [] : [unobservedSection(failed.unobserved)]),
    ...(failed.unsupported.length === 0 ? [] : [unsupportedSection(failed.unsupported)]),
    'Then call finish again with the corrected citations. Keep the rest of the answer as it is.',
  ].join('\n\n');
}

/**
 * The URL rung. Deliberately concrete about how a made-up URL gets made, because the
 * failure does not feel like invention from the inside: the observed cases are a page
 * recalled from training and a URL assembled out of the tool's own name, and a model
 * told only "that source is not real" has no reason to think either of those was what
 * it did.
 */
function unobservedSection(failed: readonly Citation[]): string {
  return [
    'No tool returned these URLs during this run, so they are not sources this run has:',
    listed(failed),
    '',
    'A cited URL has to be one you copied out of a tool result. The ways this usually goes wrong:',
    'the page is remembered from training rather than fetched here; the URL was assembled out of a',
    'tool name or a search query instead of read off a result; or a real URL was retyped with a',
    'changed path. None of them can be checked against anything, and each one reaches the reader',
    'marked unverified. For each:',
    '1. If a tool did return a page supporting the claim, copy that URL out of the tool result',
    '   exactly, and quote the text that came back with it.',
    '2. If no tool has returned such a page, go and get one: web_search for it, read it with',
    '   http_get, then cite the URL that came back.',
    '3. If neither is possible, the claim has no source in this run. Drop it, or say plainly that',
    '   the sources do not settle it.',
  ].join('\n');
}

/** The quote rung: a real source, and words it never said. */
function unsupportedSection(failed: readonly Citation[]): string {
  return [
    'These citations were checked against the text those pages returned during this run, and the',
    'quotes are not in it, character for character:',
    listed(failed),
    '',
    'That is usually one of two things: the sentence was recalled rather than copied, or it is',
    'further down a page whose read came back truncated. Fix it by reading, not by rewording —',
    'a closer paraphrase will still fail the same check. For each one:',
    '1. Re-read the source with http_get. If the earlier read had truncated=true, pass offset to',
    '   reach the part you have not seen yet.',
    '2. Find the exact sentence and paste it as the quote, unedited — do not fix its punctuation,',
    '   shorten it, or merge it with a neighbouring sentence. If you cannot find the words you meant',
    '   to quote, pick a shorter run of words you can find verbatim rather than reconstructing one.',
    '3. If the page does not say it after that, the claim is not supported. Drop the claim, or cite',
    '   a source that does say it.',
  ].join('\n');
}

/** A quote is shown when there is one — an unobserved citation need not carry one. */
function listed(citations: readonly Citation[]): string {
  return citations
    .map((citation) => {
      const quote = citation.quote === undefined ? '' : ` — “${citation.quote}”`;
      return `- [${String(citation.id)}] ${citation.url}${quote}`;
    })
    .join('\n');
}
