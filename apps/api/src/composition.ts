import { join } from 'node:path';

import type { Config } from './config/env.ts';
import { defaultFixturesDir } from './config/paths.ts';
import { createFakeLlmClient, LlmScriptSchema, type LlmScript } from './llm/fake.ts';
import type { LlmClient } from './llm/port.ts';
import { readJsonFixture } from './platform/fixtureFile.ts';
import { createFixtureDnsResolver, createFixtureHttpClient } from './platform/fixtureHttpClient.ts';
import type { GuardedGetDeps } from './platform/guardedGet.ts';
import { createAxiosHttpClient } from './platform/httpClient.ts';
import type { Logger } from './platform/logger.ts';
import { systemDnsResolver } from './platform/ssrf.ts';
import { createFixtureSearchProvider, slugify } from './search/fixture.ts';
import type { SearchProvider } from './search/port.ts';
import { createToolRegistry } from './tools/index.ts';
import type { ToolRegistry } from './tools/registry.ts';

/**
 * The composition root: the one place that knows which adapters are real and which
 * are recorded. Everything below it takes its dependencies as arguments, which is
 * why `DEMO_MODE=offline` needs no branches anywhere else in the codebase.
 */
export interface AgentRuntime {
  readonly tools: ToolRegistry;
  readonly modelId: string;
  /**
   * A fresh client per run. Offline, the script is chosen by query so a demo
   * question can have its own recorded run; live, the query is irrelevant.
   */
  readonly llmFor: (query: string) => Promise<LlmClient>;
}

export interface RuntimeOptions {
  readonly config: Config;
  readonly logger: Logger;
  /** Overridden in tests; defaults to the repo's `fixtures/` directory. */
  readonly fixturesDir?: string;
}

export function createAgentRuntime(options: RuntimeOptions): AgentRuntime {
  const { config, logger } = options;
  const fixturesDir = options.fixturesDir ?? config.fixturesDir ?? defaultFixturesDir();
  const offline = config.demoMode === 'offline';

  const searchProvider = createSearchProvider(config, fixturesDir);
  const http = createHttpDeps(offline, fixturesDir);

  logger.info(
    { demoMode: config.demoMode, search: searchProvider.name, model: config.llm.modelId },
    'agent runtime composed',
  );

  return {
    tools: createToolRegistry({ searchProvider, http }),
    modelId: offline ? 'fake-model' : config.llm.modelId,
    llmFor: (query) => {
      // M7 replaces this branch with llm/anthropic.ts. Until then live mode fails
      // loudly rather than silently falling back to fixtures — a run that claims
      // to be live must actually be live.
      if (!offline) {
        return Promise.reject(
          new Error('Live mode needs the Anthropic adapter (M7). Run with DEMO_MODE=offline.'),
        );
      }
      return createOfflineLlmClient(fixturesDir, query, logger);
    },
  };
}

function createSearchProvider(config: Config, fixturesDir: string): SearchProvider {
  if (config.search.provider === 'fixture') return createFixtureSearchProvider(fixturesDir);
  throw new Error('The Tavily search adapter arrives in M7. Use SEARCH_PROVIDER=fixture.');
}

function createHttpDeps(offline: boolean, fixturesDir: string): GuardedGetDeps {
  // Offline swaps the transport, not the guard: the SSRF checks, the redirect
  // policy and the size cap all still run, against recorded pages.
  return offline
    ? { http: createFixtureHttpClient(fixturesDir), resolveDns: createFixtureDnsResolver() }
    : { http: createAxiosHttpClient(), resolveDns: systemDnsResolver };
}

async function createOfflineLlmClient(
  fixturesDir: string,
  query: string,
  logger: Logger,
): Promise<LlmClient> {
  const dir = join(fixturesDir, 'llm');
  const slug = slugify(query);

  const script =
    (await tryLoadScript(join(dir, `${slug}.json`))) ??
    (await readJsonFixture(join(dir, 'default.json'), LlmScriptSchema));

  logger.debug({ slug, turns: script.turns.length }, 'offline llm script loaded');
  return createFakeLlmClient(script.turns);
}

async function tryLoadScript(path: string): Promise<LlmScript | undefined> {
  try {
    return await readJsonFixture(path, LlmScriptSchema);
  } catch {
    return undefined;
  }
}
