import type { Readable } from 'node:stream';

import { createAxiosHttpClient, type HttpClient, type HttpResponse } from './httpClient.ts';
import { assertSafeUrl, BlockedUrlError, systemDnsResolver, type DnsResolver } from './ssrf.ts';
import { withTimeout } from './timeout.ts';

/**
 * An HTTP GET that a language model is allowed to aim. Every limit here exists
 * because the caller is not trusted to pick a reasonable URL:
 *
 *   - the destination is re-validated on every hop, not just the first
 *   - redirects are followed by hand so each `Location` gets the same scrutiny
 *   - the body is read as a stream and abandoned the moment it exceeds the cap,
 *     so a 10 GB response costs us 1 MB
 *   - only text-ish content types come back, because the agent reads text
 */
export const GUARDED_GET_LIMITS = {
  maxRedirects: 2,
  maxBytes: 1024 * 1024,
  timeoutMs: 5_000,
} as const;

const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/xml',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
];

export class UnsupportedContentTypeError extends Error {
  constructor(contentType: string) {
    super(`content type "${contentType}" is not readable text`);
    this.name = 'UnsupportedContentTypeError';
  }
}

export interface GuardedGetResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly finalUrl: string;
  readonly truncated: boolean;
}

export interface GuardedGetDeps {
  readonly http: HttpClient;
  readonly resolveDns: DnsResolver;
}

export function createGuardedGetDeps(): GuardedGetDeps {
  return { http: createAxiosHttpClient(), resolveDns: systemDnsResolver };
}

export async function guardedGet(
  rawUrl: string,
  deps: GuardedGetDeps,
  signal?: AbortSignal,
): Promise<GuardedGetResult> {
  return withTimeout((timeoutSignal) => followAndFetch(rawUrl, deps, timeoutSignal), {
    label: `http_get ${rawUrl}`,
    timeoutMs: GUARDED_GET_LIMITS.timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  });
}

async function followAndFetch(
  rawUrl: string,
  deps: GuardedGetDeps,
  signal: AbortSignal,
): Promise<GuardedGetResult> {
  let target = rawUrl;

  for (let hop = 0; hop <= GUARDED_GET_LIMITS.maxRedirects; hop += 1) {
    const { url } = await assertSafeUrl(target, deps.resolveDns);
    const response = await deps.http.get({
      url: url.toString(),
      signal,
      headers: { accept: ALLOWED_CONTENT_TYPES.join(', ') },
    });

    const location = redirectTarget(response);
    if (location === undefined) return await readBody(response, url, signal);

    response.body.destroy();
    // Relative Location headers resolve against the URL we actually fetched, and
    // the loop sends the result back through assertSafeUrl. A redirect into a
    // private range is caught on the next pass, not followed.
    target = new URL(location, url).toString();
  }

  throw new BlockedUrlError(
    rawUrl,
    `more than ${String(GUARDED_GET_LIMITS.maxRedirects)} redirects`,
  );
}

function redirectTarget(response: HttpResponse): string | undefined {
  if (response.status < 300 || response.status >= 400) return undefined;
  const location = response.headers['location'];
  return location !== undefined && location !== '' ? location : undefined;
}

async function readBody(
  response: HttpResponse,
  url: URL,
  signal: AbortSignal,
): Promise<GuardedGetResult> {
  const mediaType = (response.headers['content-type'] ?? 'application/octet-stream')
    .split(';')[0]
    ?.trim()
    .toLowerCase();

  if (mediaType === undefined || !ALLOWED_CONTENT_TYPES.includes(mediaType)) {
    response.body.destroy();
    throw new UnsupportedContentTypeError(mediaType ?? 'unknown');
  }

  const { text, truncated } = await readCapped(response.body, signal);
  return {
    status: response.status,
    contentType: mediaType,
    body: text,
    finalUrl: url.toString(),
    truncated,
  };
}

/**
 * Reads at most `maxBytes` and then stops pulling. A server that lies about
 * Content-Length — or omits it — cannot make us buffer more than the cap.
 */
async function readCapped(
  stream: Readable,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;

  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = GUARDED_GET_LIMITS.maxBytes - size;

      if (buffer.length >= remaining) {
        chunks.push(buffer.subarray(0, remaining));
        truncated = true;
        break;
      }

      chunks.push(buffer);
      size += buffer.length;
    }
  } finally {
    stream.destroy();
  }

  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}
