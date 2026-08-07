import { z } from 'zod';

import {
  guardedGet,
  HttpStatusError,
  UnsupportedContentTypeError,
  type GuardedGetDeps,
} from '../platform/guardedGet.ts';
import { BlockedUrlError } from '../platform/ssrf.ts';
import { TimeoutError } from '../platform/timeout.ts';
import { ToolExecutionError, type Tool } from './types.ts';

/**
 * Enough of a page for the model to quote and cite; short enough not to flood the
 * context.
 *
 * 4,000 was too short to be that, and the failure was quiet. A long comparison
 * article runs to 35,000 characters of extracted text, so the first 4,000 were the
 * navigation and the opening paragraphs — the excerpt ended mid-sentence, and the
 * facts worth citing sat at 6,000 and 8,000 and 27,000. The agent was reading a page
 * that did not contain what it needed and had no way to say so, and the citations it
 * wrote from memory were what the grounding check ended up catching.
 */
const MAX_EXCERPT_CHARS = 12_000;

const InputSchema = z.object({
  url: z.url().max(2_048).describe('An absolute http(s) URL, normally one web_search returned.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Where to start reading, in characters. Omit for the beginning of the page. If a previous ' +
        'read of this URL came back with truncated=true, call again with offset set to that ' +
        "read's nextOffset to continue from where it stopped.",
    ),
});

const OutputSchema = z.object({
  status: z.number().int(),
  contentType: z.string(),
  textExcerpt: z.string(),
  truncated: z.boolean(),
  /** Where this excerpt starts, so a continuing read is anchored rather than guessed. */
  offset: z.number().int(),
  /** How much text the page has in total, so the model can judge what it is missing. */
  totalChars: z.number().int(),
  /**
   * Where to resume. Present only when there is more to read, which makes
   * `truncated` actionable instead of merely informative — the model can carry on
   * rather than falling back on what it remembers about the page.
   */
  nextOffset: z.number().int().optional(),
  /** The URL actually read, which differs from the input when redirects were followed. */
  finalUrl: z.url(),
});

export function createHttpGetTool(
  deps: GuardedGetDeps,
): Tool<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> {
  return {
    name: 'http_get',
    description:
      'Fetch a web page or JSON document and return its text. Use it to read a source properly ' +
      'before citing it. Only http and https public addresses are reachable. Long pages come ' +
      'back in pieces: if the result says truncated, the sentence you want may be further down, ' +
      'so read on with offset before concluding the page does not say it.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    // Slightly above the guarded fetch's own 5s deadline, so a timeout is reported
    // by the layer that knows why it happened.
    timeoutMs: 6_000,
    evidence: 'fetched',
    execute: async ({ url, offset }, ctx) => {
      try {
        const response = await guardedGet(url, deps, ctx.signal);
        const text = extractText(response.body, response.contentType);

        // Clamped rather than rejected: an offset past the end is the model having
        // misjudged how long the page was, and an empty excerpt with the totals
        // beside it tells it so more usefully than an error it has to recover from.
        const start = Math.min(offset ?? 0, text.length);
        const excerpt = text.slice(start, start + MAX_EXCERPT_CHARS);
        const end = start + excerpt.length;
        const more = end < text.length;

        return {
          status: response.status,
          contentType: response.contentType,
          textExcerpt: excerpt,
          // The body may also have been cut at the transfer limit, in which case
          // there is more page than there is text, and `nextOffset` cannot reach it.
          truncated: response.truncated || more,
          offset: start,
          totalChars: text.length,
          ...(more ? { nextOffset: end } : {}),
          finalUrl: response.finalUrl,
        };
      } catch (error) {
        throw explain(error, url);
      }
    },
  };
}

/**
 * Every refusal is turned into a sentence the model can act on. "Blocked" with no
 * reason makes a model retry the same URL; "that host is internal" makes it move on.
 */
function explain(error: unknown, url: string): Error {
  if (error instanceof BlockedUrlError) {
    return new ToolExecutionError(`${error.message}. Pick a different, public URL.`);
  }
  if (error instanceof HttpStatusError) {
    return new ToolExecutionError(`${url} ${error.message}. ${statusAdvice(error.status)}`);
  }
  if (error instanceof UnsupportedContentTypeError) {
    return new ToolExecutionError(`${url} is not readable text: ${error.message}.`);
  }
  if (error instanceof TimeoutError) {
    return error;
  }
  return new ToolExecutionError(
    `Could not fetch ${url}: ${error instanceof Error ? error.message : 'unknown error'}.`,
  );
}

/**
 * What to do about a status, and — every time — what not to do about it.
 *
 * The instruction not to cite an unread page is repeated in each branch rather than
 * appended once, because the failure this exists to stop is specific: the model
 * knows roughly what a well-known article says, is told only that a fetch failed,
 * and writes the citation anyway from memory. The refusal has to say that the page
 * is now off-limits as a source, not merely that a request did not work.
 */
function statusAdvice(status: number): string {
  const doNotCite = 'Do not cite this page: you have not read it.';

  if (status === 404 || status === 410) {
    return `That page is gone or the URL is wrong. Search for the source again rather than guessing another URL. ${doNotCite}`;
  }
  if (status === 401 || status === 403 || status === 429) {
    return `The site is refusing automated readers, so this page cannot be read at all. Find the same facts on a different site. ${doNotCite}`;
  }
  if (status >= 500) {
    return `The site is failing right now. Try a different source rather than retrying. ${doNotCite}`;
  }
  return `That is not a page that can be read. Try a different source. ${doNotCite}`;
}

/**
 * The named entities worth decoding.
 *
 * These earn their place now that citation quotes are matched against this text
 * character for character. An undecoded `&mdash;` sitting in the middle of a
 * sentence makes that sentence unquotable — the agent copies what it was shown, and
 * what it was shown was wrong.
 */
const NAMED_ENTITIES: readonly (readonly [RegExp, string])[] = [
  [/&nbsp;/giu, ' '],
  [/&mdash;/giu, '—'],
  [/&ndash;/giu, '–'],
  [/&[lr]squo;/giu, "'"],
  [/&[lr]dquo;/giu, '"'],
  [/&hellip;/giu, '…'],
  [/&lt;/giu, '<'],
  [/&gt;/giu, '>'],
  [/&quot;/giu, '"'],
  [/&apos;/giu, "'"],
];

/** Decimal and hex character references: `&#8217;`, `&#x2019;`, `&#038;`. */
const NUMERIC_ENTITY = /&#(x[0-9a-f]+|[0-9]+);/giu;

/**
 * Decodes numeric character references, which a hand-written table cannot cover.
 *
 * Named entities are a closed set someone can enumerate; numeric ones are every
 * code point there is, and publishing platforms emit them for exactly the
 * punctuation that shows up mid-sentence. A WordPress page will write `Harvard&#8217;s`
 * in one sentence and a literal `Harvard’s` in the next, so without this the agent
 * is shown a page where some sentences are quotable and some are not, with nothing
 * on screen to say which — the quiet failure this whole extraction step exists to
 * avoid.
 *
 * A reference that is not a usable code point is left as written rather than
 * guessed at: text that was never prose should not be invented into some.
 */
function decodeNumericEntities(text: string): string {
  return text.replace(NUMERIC_ENTITY, (whole, code: string) => {
    const point = code.toLowerCase().startsWith('x')
      ? Number.parseInt(code.slice(1), 16)
      : Number.parseInt(code, 10);

    if (!Number.isInteger(point) || point < 1 || point > 0x10_ff_ff) return whole;
    // Lone surrogates are not characters, and String.fromCodePoint would produce an
    // unpaired one that breaks the JSON this excerpt is serialised into.
    if (point >= 0xd8_00 && point <= 0xdf_ff) return ' ';

    return String.fromCodePoint(point);
  });
}

/**
 * Every decoding step, in the order a browser would apply them: `&amp;` last, so a
 * doubly-encoded `&amp;lt;` becomes the literal `&lt;` it stood for rather than a
 * `<` that was never in the document. Numeric references sit just before it for the
 * same reason in both directions — `&#38;lt;` decodes to a literal `&lt;` because
 * the named pass has already gone by, and `&amp;#8217;` survives as literal text
 * because this pass runs before the ampersand is restored.
 */
const DECODERS: readonly ((text: string) => string)[] = [
  ...NAMED_ENTITIES.map(
    ([pattern, replacement]) =>
      (text: string): string =>
        text.replace(pattern, replacement),
  ),
  decodeNumericEntities,
  (text: string): string => text.replace(/&amp;/giu, '&'),
];

/**
 * A deliberately small HTML-to-text step: drop the parts that are never prose,
 * strip tags, decode the handful of entities that matter, and collapse whitespace.
 * A real parser would be better and is not worth a dependency for an excerpt.
 */
export function extractText(body: string, contentType: string): string {
  if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
    return body.trim();
  }

  const stripped = body
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<[^>]+>/gu, ' ');

  return DECODERS.reduce((text, decode) => decode(text), stripped)
    .replace(/\s+/gu, ' ')
    .trim();
}
