import { join } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';

import { readJsonFixture } from './fixtureFile.ts';
import type { HttpClient } from './httpClient.ts';
import type { DnsResolver } from './ssrf.ts';

/**
 * Serves `http_get` from `fixtures/pages/` so an offline run makes no network call
 * at all — not "no LLM call", none.
 *
 * Without this, the offline demo would replay a recorded model turn and then
 * genuinely reach out to whatever URL that turn named, and the promise on the box
 * would be false the first time someone demoed it on a plane.
 */
const PageFixtureSchema = z.object({
  url: z.url(),
  status: z.number().int().default(200),
  contentType: z.string().default('text/html'),
  body: z.string(),
});

export function createFixtureHttpClient(fixturesDir: string): HttpClient {
  const dir = join(fixturesDir, 'pages');

  return {
    get: async ({ url }) => {
      const page = await tryRead(join(dir, `${slugifyUrl(url)}.json`));

      if (page === undefined) {
        return {
          status: 404,
          headers: { 'content-type': 'text/plain' },
          body: Readable.from([`No recorded page for ${url}. This run is offline.`]),
        };
      }

      return {
        status: page.status,
        headers: { 'content-type': page.contentType },
        body: Readable.from([page.body]),
      };
    },
  };
}

/**
 * DNS never runs offline, but the SSRF guard still does — an offline run exercises
 * exactly the same code path as a live one, including the blocklist.
 */
export function createFixtureDnsResolver(): DnsResolver {
  return () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
}

async function tryRead(path: string): Promise<z.infer<typeof PageFixtureSchema> | undefined> {
  try {
    return await readJsonFixture(path, PageFixtureSchema);
  } catch {
    return undefined;
  }
}

/** `https://example.com/optics/rayleigh` → `example-com-optics-rayleigh`. */
export function slugifyUrl(url: string): string {
  return url
    .replace(/^https?:\/\//iu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 120);
}
