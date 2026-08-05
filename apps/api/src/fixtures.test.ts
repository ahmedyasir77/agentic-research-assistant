import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defaultFixturesDir } from './config/paths.ts';
import { LlmScriptSchema } from './llm/fake.ts';
import { readJsonFixture } from './platform/fixtureFile.ts';
import { slugifyUrl } from './platform/fixtureHttpClient.ts';
import { SearchResultSchema } from './search/port.ts';
import { slugify } from './search/fixture.ts';
import { createToolRegistry } from './tools/index.ts';
import { silentLogger } from './platform/logger.ts';
import { Readable } from 'node:stream';

/**
 * The fixtures are the offline demo. A typo in one of them is a demo that fails in
 * front of an audience, so they are validated in CI like any other input — against
 * the same schemas the runtime uses, plus the tool schemas the model must satisfy.
 */
const FIXTURES = defaultFixturesDir();

const SearchFixtureSchema = z.object({ query: z.string(), results: z.array(SearchResultSchema) });
const PageFixtureSchema = z.object({
  url: z.url(),
  status: z.number().int().default(200),
  contentType: z.string().default('text/html'),
  body: z.string(),
});

async function jsonFilesIn(dir: string): Promise<string[]> {
  const entries = await readdir(join(FIXTURES, dir));
  return entries.filter((name) => name.endsWith('.json'));
}

const registry = createToolRegistry({
  searchProvider: { name: 'stub', search: () => Promise.resolve([]) },
  http: {
    http: {
      get: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: Readable.from(['ok']),
        }),
    },
    resolveDns: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
  },
});

describe('search fixtures', () => {
  it('has a fallback so an unrecorded query still returns something', async () => {
    expect(await jsonFilesIn('search')).toContain('default.json');
  });

  it('every file parses, and its filename matches the query it records', async () => {
    for (const file of await jsonFilesIn('search')) {
      const fixture = await readJsonFixture(join(FIXTURES, 'search', file), SearchFixtureSchema);
      expect(fixture.results.length, file).toBeGreaterThan(0);

      // A fixture whose name does not match its query is unreachable at runtime.
      if (file !== 'default.json') {
        expect(`${slugify(fixture.query)}.json`.startsWith(file.replace('.json', '')), file).toBe(
          true,
        );
      }
    }
  });
});

describe('page fixtures', () => {
  it('every file parses, and its filename matches the url it records', async () => {
    for (const file of await jsonFilesIn('pages')) {
      const fixture = await readJsonFixture(join(FIXTURES, 'pages', file), PageFixtureSchema);
      expect(`${slugifyUrl(fixture.url)}.json`, file).toBe(file);
    }
  });
});

describe('llm fixtures', () => {
  it('has a fallback script for unrecorded queries', async () => {
    expect(await jsonFilesIn('llm')).toContain('default.json');
  });

  it('every script parses and ends by calling finish', async () => {
    for (const file of await jsonFilesIn('llm')) {
      const script = await readJsonFixture(join(FIXTURES, 'llm', file), LlmScriptSchema);
      const lastTurn = script.turns.at(-1);
      const finishCall = lastTurn?.content.find(
        (block) => block.type === 'tool_use' && block.name === 'finish',
      );

      // A script that never calls finish would demo the no_tool_call failure path,
      // which is a deliberate scenario — not what the recorded happy paths are for.
      expect(finishCall, `${file} must end with a finish call`).toBeDefined();
    }
  });

  it('every recorded tool call would pass the real tool schema', async () => {
    for (const file of await jsonFilesIn('llm')) {
      const script = await readJsonFixture(join(FIXTURES, 'llm', file), LlmScriptSchema);

      for (const scriptTurn of script.turns) {
        for (const block of scriptTurn.content) {
          if (block.type !== 'tool_use') continue;

          const { outcome } = await registry.invoke(block.name, block.input, {
            runId: 'fixture-check',
            step: 0,
            signal: new AbortController().signal,
            logger: silentLogger,
          });

          if (outcome.status === 'error') {
            expect(outcome.error.kind, `${file} → ${block.name}`).not.toBe('invalid_arguments');
            expect(outcome.error.kind, `${file} → ${block.name}`).not.toBe('unknown_tool');
          }
        }
      }
    }
  });

  it('cites only urls the script itself would have seen', async () => {
    for (const file of await jsonFilesIn('llm')) {
      const script = await readJsonFixture(join(FIXTURES, 'llm', file), LlmScriptSchema);
      const reachable = await urlsReachableBy(script);

      for (const scriptTurn of script.turns) {
        for (const block of scriptTurn.content) {
          if (block.type !== 'tool_use' || block.name !== 'finish') continue;
          for (const url of citedUrls(block.input)) {
            // Not "appears in some fixture somewhere" — appears in a fixture this
            // script's own tool calls would resolve to. A search fixture named
            // after the wrong query is unreachable, and a demo that cites it shows
            // the citation check failing on a source that was supposed to be real.
            expect([...reachable], `${file} cites ${url}`).toContain(url);
          }
        }
      }
    }
  });
});

/**
 * Every URL a script's own tool calls would put in front of the citation check,
 * resolved by the same slug rules the adapters use at runtime. The `finish` call
 * is excluded for the same reason the agent excludes it: its output is the claim,
 * not the evidence.
 */
async function urlsReachableBy(script: z.infer<typeof LlmScriptSchema>): Promise<Set<string>> {
  const reachable = new Set<string>();

  for (const scriptTurn of script.turns) {
    for (const block of scriptTurn.content) {
      if (block.type !== 'tool_use') continue;

      if (block.name === 'web_search') {
        const parsed = SearchArgsSchema.safeParse(block.input);
        if (!parsed.success) continue;
        const fixture =
          (await tryReadFixture(`search/${slugify(parsed.data.query)}.json`)) ??
          (await readJsonFixture(join(FIXTURES, 'search', 'default.json'), SearchFixtureSchema));
        for (const result of fixture.results.slice(0, parsed.data.maxResults)) {
          reachable.add(result.url);
        }
      }

      if (block.name === 'http_get') {
        const parsed = UrlArgsSchema.safeParse(block.input);
        if (parsed.success && (await pageFixtureExists(parsed.data.url))) {
          reachable.add(parsed.data.url);
        }
      }
    }
  }

  return reachable;
}

const SearchArgsSchema = z.object({ query: z.string(), maxResults: z.number().default(5) });
const UrlArgsSchema = z.object({ url: z.string() });
const CitationsSchema = z.object({ citations: z.array(z.object({ url: z.string() })) });

async function tryReadFixture(
  relativePath: string,
): Promise<z.infer<typeof SearchFixtureSchema> | undefined> {
  try {
    return await readJsonFixture(join(FIXTURES, relativePath), SearchFixtureSchema);
  } catch {
    return undefined;
  }
}

async function pageFixtureExists(url: string): Promise<boolean> {
  return (await jsonFilesIn('pages')).includes(`${slugifyUrl(url)}.json`);
}

function citedUrls(input: unknown): string[] {
  const parsed = CitationsSchema.safeParse(input);
  return parsed.success ? parsed.data.citations.map((citation) => citation.url) : [];
}
