import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  guardedGet,
  GUARDED_GET_LIMITS,
  UnsupportedContentTypeError,
  type GuardedGetDeps,
} from './guardedGet.ts';
import type { HttpClient, HttpResponse } from './httpClient.ts';
import { BlockedUrlError, type DnsResolver } from './ssrf.ts';

interface FakeResponse {
  readonly status?: number;
  readonly contentType?: string;
  readonly location?: string;
  readonly body?: string | Buffer;
}

/** A scripted HTTP client: one queued response per hop, and a record of what was asked for. */
function fakeHttp(script: readonly FakeResponse[]): { client: HttpClient; urls: string[] } {
  const queue = [...script];
  const urls: string[] = [];

  const client: HttpClient = {
    get: (request) => {
      urls.push(request.url);
      const next = queue.shift();
      if (next === undefined) throw new Error(`Unexpected request to ${request.url}`);

      const response: HttpResponse = {
        status: next.status ?? 200,
        headers: {
          'content-type': next.contentType ?? 'text/html; charset=utf-8',
          ...(next.location === undefined ? {} : { location: next.location }),
        },
        body: Readable.from([next.body ?? '<p>hello</p>']),
      };
      return Promise.resolve(response);
    },
  };

  return { client, urls };
}

/** Resolves each hostname to whatever the test maps it to; anything else is public. */
function dnsMap(map: Readonly<Record<string, string>> = {}): DnsResolver {
  return (hostname) => Promise.resolve([{ address: map[hostname] ?? '93.184.216.34', family: 4 }]);
}

function deps(
  script: readonly FakeResponse[],
  map?: Record<string, string>,
): GuardedGetDeps & {
  urls: string[];
} {
  const { client, urls } = fakeHttp(script);
  return { http: client, resolveDns: dnsMap(map), urls };
}

describe('guardedGet', () => {
  it('reads a public page', async () => {
    const result = await guardedGet('https://example.com/a', deps([{ body: '<p>hi</p>' }]));
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/html');
    expect(result.body).toBe('<p>hi</p>');
    expect(result.truncated).toBe(false);
    expect(result.finalUrl).toBe('https://example.com/a');
  });

  it('follows a redirect and reports the final url', async () => {
    const d = deps([
      { status: 302, location: 'https://example.com/b' },
      { body: '<p>arrived</p>' },
    ]);
    const result = await guardedGet('https://example.com/a', d);
    expect(result.body).toBe('<p>arrived</p>');
    expect(result.finalUrl).toBe('https://example.com/b');
    expect(d.urls).toStrictEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('resolves a relative Location against the url it actually fetched', async () => {
    const d = deps([
      { status: 301, location: '/moved' },
      { body: 'ok', contentType: 'text/plain' },
    ]);
    await guardedGet('https://example.com/deep/page', d);
    expect(d.urls[1]).toBe('https://example.com/moved');
  });

  it('re-checks every hop, so a redirect into a private range is blocked', async () => {
    // The classic bypass: a public URL that 302s to the metadata service. The
    // first request is fine; the second never happens.
    const d = deps([{ status: 302, location: 'http://internal.example.com/' }], {
      'internal.example.com': '169.254.169.254',
    });

    await expect(guardedGet('https://example.com/a', d)).rejects.toThrow(BlockedUrlError);
    expect(d.urls).toStrictEqual(['https://example.com/a']);
  });

  it('gives up after the redirect limit rather than following a loop', async () => {
    const hop = { status: 302, location: 'https://example.com/next' };
    const d = deps([hop, hop, hop, hop]);
    await expect(guardedGet('https://example.com/a', d)).rejects.toThrow(/more than 2 redirects/u);
    expect(d.urls).toHaveLength(GUARDED_GET_LIMITS.maxRedirects + 1);
  });

  it('stops reading at the size cap and says the body was truncated', async () => {
    const oversized = Buffer.alloc(GUARDED_GET_LIMITS.maxBytes + 50_000, 'a');
    const result = await guardedGet(
      'https://example.com/big',
      deps([{ body: oversized, contentType: 'text/plain' }]),
    );
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBe(GUARDED_GET_LIMITS.maxBytes);
  });

  it('refuses content types that are not readable text', async () => {
    await expect(
      guardedGet('https://example.com/x.pdf', deps([{ contentType: 'application/pdf' }])),
    ).rejects.toThrow(UnsupportedContentTypeError);
  });

  it.each(['application/json', 'text/plain', 'text/markdown', 'text/csv'])(
    'accepts %s',
    async (contentType) => {
      const result = await guardedGet('https://example.com/x', deps([{ contentType, body: 'x' }]));
      expect(result.contentType).toBe(contentType);
    },
  );

  it('blocks the request before it is made when the url is unsafe', async () => {
    const d = deps([], { 'evil.example.com': '10.1.2.3' });
    await expect(guardedGet('https://evil.example.com/', d)).rejects.toThrow(BlockedUrlError);
    expect(d.urls).toStrictEqual([]);
  });
});
