import { join } from 'node:path';
import { z } from 'zod';

import { readJsonFixture } from '../platform/fixtureFile.ts';
import { SearchResultSchema, type SearchProvider, type SearchRequest } from './port.ts';

/**
 * Search results read from `fixtures/search/`, so an offline run behaves like a
 * real one without touching the network.
 *
 * A query is matched to a file by slug. Anything unrecognised falls back to
 * `default.json` rather than returning nothing — an offline demo where an
 * off-script question yields an empty result set would be worse than useless.
 */
const FixtureFileSchema = z.object({
  query: z.string(),
  results: z.array(SearchResultSchema),
});

export const FIXTURE_FALLBACK_SLUG = 'default';

export function createFixtureSearchProvider(fixturesDir: string): SearchProvider {
  const dir = join(fixturesDir, 'search');

  return {
    name: 'fixture',
    search: async ({ query, maxResults }: SearchRequest) => {
      const fixture =
        (await tryRead(join(dir, `${slugify(query)}.json`))) ??
        (await readJsonFixture(join(dir, `${FIXTURE_FALLBACK_SLUG}.json`), FixtureFileSchema));

      return fixture.results.slice(0, maxResults);
    },
  };
}

async function tryRead(path: string): Promise<z.infer<typeof FixtureFileSchema> | undefined> {
  try {
    return await readJsonFixture(path, FixtureFileSchema);
  } catch {
    // A missing file is the normal case for an off-script query; a malformed one
    // is caught by the fixture validation test rather than at demo time.
    return undefined;
  }
}

/** `Why is the sky blue?` → `why-is-the-sky-blue`, so a fixture is findable by name. */
export function slugify(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
}
