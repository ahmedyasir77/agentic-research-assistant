import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { secret } from '../config/secret.ts';
import { createAxiosJsonPoster } from '../platform/jsonPost.ts';
import { isTransient } from '../platform/transient.ts';
import { SearchProviderError } from './port.ts';
import { createTavilySearchProvider } from './tavily.ts';

const SEARCH_URL = 'https://api.tavily.test/search';

let lastBody: unknown;
let lastHeaders: Headers | undefined;
// Typed as `Response` because msw's own return type is generic in the body;
// the handler only needs to hand it back.
let reply: () => Response = () => HttpResponse.json(okResults());

const server = setupServer(
  http.post(SEARCH_URL, async ({ request }) => {
    lastBody = await request.json();
    lastHeaders = request.headers;
    return reply();
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  reply = () => HttpResponse.json(okResults());
  lastBody = undefined;
  lastHeaders = undefined;
});

const provider = createTavilySearchProvider({
  apiKey: secret('tvly-test-key'),
  post: createAxiosJsonPoster(),
  baseUrl: 'https://api.tavily.test',
});

function search(maxResults = 3) {
  return provider.search({
    query: 'why is the sky blue',
    maxResults,
    signal: new AbortController().signal,
  });
}

function okResults(results: unknown[] = [defaultResult()]) {
  return { query: 'why is the sky blue', results, response_time: 0.4 };
}

function defaultResult(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Rayleigh scattering',
    url: 'https://en.wikipedia.org/wiki/Rayleigh_scattering',
    content: 'Scattering varies inversely with the fourth power of the wavelength.',
    score: 0.97,
    ...overrides,
  };
}

describe('the request it sends', () => {
  it('authenticates with a bearer token and nowhere else', async () => {
    await search();

    expect(lastHeaders?.get('authorization')).toBe('Bearer tvly-test-key');
    expect(JSON.stringify(lastBody)).not.toContain('tvly-test-key');
  });

  it('asks for exactly the number of results the tool wants', async () => {
    await search(5);

    expect(lastBody).toMatchObject({ query: 'why is the sky blue', max_results: 5 });
  });

  it('declines the synthesised answer', async () => {
    await search();

    // The agent's whole point is an answer built from sources it can cite; an
    // uncited paragraph from the search provider would undercut that.
    expect(lastBody).toMatchObject({ include_answer: false });
  });
});

describe('the results it returns', () => {
  it('maps the vendor shape onto the port', async () => {
    expect(await search()).toStrictEqual([
      {
        title: 'Rayleigh scattering',
        url: 'https://en.wikipedia.org/wiki/Rayleigh_scattering',
        snippet: 'Scattering varies inversely with the fourth power of the wavelength.',
      },
    ]);
  });

  it('normalises a publication date into the ISO timestamp the port promises', async () => {
    reply = () =>
      HttpResponse.json(
        okResults([defaultResult({ published_date: 'Wed, 14 May 2026 09:12:00 GMT' })]),
      );

    expect((await search())[0]?.publishedAt).toBe('2026-05-14T09:12:00.000Z');
  });

  it('drops a date it cannot parse rather than passing on a wrong one', async () => {
    reply = () => HttpResponse.json(okResults([defaultResult({ published_date: 'sometime' })]));

    expect((await search())[0]).not.toHaveProperty('publishedAt');
  });

  it('accepts an empty result set', async () => {
    reply = () => HttpResponse.json(okResults([]));

    expect(await search()).toStrictEqual([]);
  });

  it('rejects a body it cannot read rather than returning half a result', async () => {
    reply = () => HttpResponse.json({ results: [{ title: 'no url' }] });

    await expect(search()).rejects.toBeInstanceOf(SearchProviderError);
  });
});

describe('when the API fails', () => {
  it('reports the provider’s own message and names the provider', async () => {
    reply = () =>
      HttpResponse.json({ detail: { error: 'missing or invalid API key' } }, { status: 401 });

    await expect(search()).rejects.toThrow(/tavily search failed: HTTP 401 — missing or invalid/u);
  });

  it('marks a rate limit as worth retrying and a bad request as not', async () => {
    reply = () => HttpResponse.json({ detail: { error: 'excessive requests' } }, { status: 429 });
    const rateLimited = await search().catch((error: unknown) => error);

    reply = () => HttpResponse.json({ detail: { error: 'invalid topic' } }, { status: 400 });
    const badRequest = await search().catch((error: unknown) => error);

    expect(isTransient(rateLimited)).toBe(true);
    expect(isTransient(badRequest)).toBe(false);
  });

  it('never puts the key in the error it raises', async () => {
    reply = () => HttpResponse.json({ detail: { error: 'nope' } }, { status: 401 });

    const error = await search().catch((caught: unknown) => caught);

    expect(String(error)).not.toContain('tvly-test-key');
  });
});
