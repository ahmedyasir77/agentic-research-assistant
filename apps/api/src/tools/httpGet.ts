import { z } from 'zod';

import {
  guardedGet,
  UnsupportedContentTypeError,
  type GuardedGetDeps,
} from '../platform/guardedGet.ts';
import { BlockedUrlError } from '../platform/ssrf.ts';
import { TimeoutError } from '../platform/timeout.ts';
import { ToolExecutionError, type Tool } from './types.ts';

/** Enough of a page for the model to quote and cite; short enough not to flood the context. */
const MAX_EXCERPT_CHARS = 4_000;

const InputSchema = z.object({
  url: z.url().max(2_048).describe('An absolute http(s) URL, normally one web_search returned.'),
});

const OutputSchema = z.object({
  status: z.number().int(),
  contentType: z.string(),
  textExcerpt: z.string(),
  truncated: z.boolean(),
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
      'before citing it. Only http and https public addresses are reachable.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    // Slightly above the guarded fetch's own 5s deadline, so a timeout is reported
    // by the layer that knows why it happened.
    timeoutMs: 6_000,
    execute: async ({ url }, ctx) => {
      try {
        const response = await guardedGet(url, deps, ctx.signal);
        const text = extractText(response.body, response.contentType);
        return {
          status: response.status,
          contentType: response.contentType,
          textExcerpt: text.slice(0, MAX_EXCERPT_CHARS),
          truncated: response.truncated || text.length > MAX_EXCERPT_CHARS,
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
 * A deliberately small HTML-to-text step: drop the parts that are never prose,
 * strip tags, decode the handful of entities that matter, and collapse whitespace.
 * A real parser would be better and is not worth a dependency for an excerpt.
 */
export function extractText(body: string, contentType: string): string {
  if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
    return body.trim();
  }

  return body
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}
