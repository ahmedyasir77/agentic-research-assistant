import { join } from 'node:path';

import { createAnthropicClient } from './llm/anthropic.ts';
import type { Config } from './config/env.ts';
import { defaultFixturesDir } from './config/paths.ts';
import { createFakeLlmClient, LlmScriptSchema, type LlmScript } from './llm/fake.ts';
import { isPricingKnown } from './llm/pricing.ts';
import type { LlmClient } from './llm/port.ts';
import { readJsonFixture } from './platform/fixtureFile.ts';
import { createFixtureDnsResolver, createFixtureHttpClient } from './platform/fixtureHttpClient.ts';
import type { GuardedGetDeps } from './platform/guardedGet.ts';
import { createAxiosHttpClient } from './platform/httpClient.ts';
import { createAxiosJsonPoster, type JsonPoster } from './platform/jsonPost.ts';
import type { Logger } from './platform/logger.ts';
import { systemDnsResolver } from './platform/ssrf.ts';
import { createFixtureSearchProvider, slugify } from './search/fixture.ts';
import { createTavilySearchProvider } from './search/tavily.ts';
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
  /** Overridden in tests so an adapter can be pointed at a stub server. */
  readonly post?: JsonPoster;
}

export function createAgentRuntime(options: RuntimeOptions): AgentRuntime {
  const { config, logger } = options;
  const fixturesDir = options.fixturesDir ?? config.fixturesDir ?? defaultFixturesDir();
  const offline = config.demoMode === 'offline';

  const post = options.post ?? createAxiosJsonPoster();
  const searchProvider = createSearchProvider(config, fixturesDir, post);
  const http = createHttpDeps(offline, fixturesDir);

  logger.info(
    { demoMode: config.demoMode, search: searchProvider.name, model: config.llm.modelId },
    'agent runtime composed',
  );

  // Said once, at boot, rather than silently on every run: an unpriced model is
  // billed at the fallback tier, so every cost in the trace is a guess.
  if (!offline && !isPricingKnown(config.llm.modelId)) {
    logger.warn(
      { model: config.llm.modelId },
      'no list price for this model — estimated costs will use the fallback tier and be wrong',
    );
  }

  return {
    tools: createToolRegistry({ searchProvider, http }),
    modelId: offline ? 'fake-model' : config.llm.modelId,
    llmFor: (query) => {
      if (!offline) {
        // Config already refuses to start live without a key; this narrows the
        // type at the one place that needs the value rather than asserting.
        const apiKey = config.llm.apiKey;
        if (apiKey === undefined) {
          return Promise.reject(new Error('DEMO_MODE=live needs ANTHROPIC_API_KEY.'));
        }
        return Promise.resolve(
          createAnthropicClient({ apiKey, modelId: config.llm.modelId, post }),
        );
      }
      return createOfflineLlmClient(fixturesDir, query, logger);
    },
  };
}

function createSearchProvider(
  config: Config,
  fixturesDir: string,
  post: JsonPoster,
): SearchProvider {
  if (config.search.provider === 'fixture') return createFixtureSearchProvider(fixturesDir);

  const apiKey = config.search.apiKey;
  if (apiKey === undefined) throw new Error('SEARCH_PROVIDER=tavily needs TAVILY_API_KEY.');
  return createTavilySearchProvider({ apiKey, post });
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
