import { describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../platform/logger.ts';
import { SearchProviderError, type SearchProvider, type SearchResult } from '../search/port.ts';
import { createWebSearchTool } from './webSearch.ts';
import { ToolExecutionError, type ToolContext } from './types.ts';

const ctx: ToolContext = {
  runId: 'run_1',
  step: 0,
  signal: new AbortController().signal,
  logger: silentLogger,
};

function result(n: number): SearchResult {
  return {
    title: `Result ${String(n)}`,
    url: `https://example.com/${String(n)}`,
    snippet: 'A snippet.',
  };
}

/** Never actually waits, so a retry test costs microseconds. */
const noSleep = () => Promise.resolve();

describe('web_search', () => {
  it('returns what the provider found', async () => {
    const provider: SearchProvider = {
      name: 'stub',
      search: () => Promise.resolve([result(1), result(2)]),
    };
    const tool = createWebSearchTool({ provider, sleep: noSleep });

    const output = await tool.execute({ query: 'rayleigh scattering', maxResults: 3 }, ctx);
    expect(output.results).toHaveLength(2);
    expect(output.results[0]?.url).toBe('https://example.com/1');
  });

  it('passes the query and result count through to the provider', async () => {
    const search = vi.fn(() => Promise.resolve([]));
    const tool = createWebSearchTool({ provider: { name: 'stub', search }, sleep: noSleep });

    await tool.execute({ query: 'why is the sky blue', maxResults: 2 }, ctx);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'why is the sky blue', maxResults: 2 }),
    );
  });

  it('never returns more than the model asked for, even if the provider over-delivers', async () => {
    const provider: SearchProvider = {
      name: 'chatty',
      search: () => Promise.resolve([result(1), result(2), result(3), result(4), result(5)]),
    };
    const tool = createWebSearchTool({ provider, sleep: noSleep });

    const output = await tool.execute({ query: 'anything', maxResults: 2 }, ctx);
    expect(output.results).toHaveLength(2);
  });

  it('retries a transient provider failure and then succeeds', async () => {
    let calls = 0;
    const provider: SearchProvider = {
      name: 'flaky',
      search: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(Object.assign(new Error('boom'), { response: { status: 503 } }));
        }
        return Promise.resolve([result(1)]);
      },
    };
    const tool = createWebSearchTool({ provider, sleep: noSleep });

    const output = await tool.execute({ query: 'anything', maxResults: 3 }, ctx);
    expect(output.results).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('turns a permanent failure into advice the model can act on', async () => {
    const provider: SearchProvider = {
      name: 'broken',
      search: () => Promise.reject(new SearchProviderError('broken', 'quota exhausted')),
    };
    const tool = createWebSearchTool({ provider, sleep: noSleep });

    const promise = tool.execute({ query: 'anything', maxResults: 3 }, ctx);
    await expect(promise).rejects.toThrow(ToolExecutionError);
    await expect(promise).rejects.toThrow(/Try a different query/u);
  });

  it('defaults maxResults so the model can omit it', () => {
    const parsed = createWebSearchTool({
      provider: { name: 'stub', search: () => Promise.resolve([]) },
    }).inputSchema.parse({ query: 'anything' });

    expect(parsed.maxResults).toBe(3);
  });

  it('rejects a request for more results than the cap allows', () => {
    const tool = createWebSearchTool({
      provider: { name: 'stub', search: () => Promise.resolve([]) },
    });
    expect(tool.inputSchema.safeParse({ query: 'anything', maxResults: 50 }).success).toBe(false);
  });
});
