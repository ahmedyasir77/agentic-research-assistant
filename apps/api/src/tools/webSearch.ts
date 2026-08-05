import { z } from 'zod';

import type { Logger } from '../platform/logger.ts';
import { withRetry } from '../platform/retry.ts';
import { SearchResultSchema, type SearchProvider } from '../search/port.ts';
import { ToolExecutionError, type Tool } from './types.ts';

const InputSchema = z.object({
  query: z.string().min(2).max(300).describe('The search query. Be specific.'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe('How many results to return. Ask for fewer when the question is narrow.'),
});

const OutputSchema = z.object({ results: z.array(SearchResultSchema) });

export interface WebSearchDeps {
  readonly provider: SearchProvider;
  /** Injected so the backoff test does not actually wait. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Search is retried because it is a network call to someone else's service and its
 * failures are usually transient. `http_get` deliberately is not — see
 * docs/DECISIONS.md.
 */
export function createWebSearchTool(
  deps: WebSearchDeps,
): Tool<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> {
  return {
    name: 'web_search',
    description:
      'Search the web for pages relevant to a query. Returns titles, URLs and snippets. ' +
      'Start here when you need facts you do not already have; follow up with http_get to read a page in full.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    timeoutMs: 10_000,
    execute: async ({ query, maxResults }, ctx) => {
      const results = await withRetry(
        () => deps.provider.search({ query, maxResults, signal: ctx.signal }),
        {
          signal: ctx.signal,
          ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
          onRetry: ({ attempt, delayMs, error }) => {
            logRetry(ctx.logger, deps.provider.name, attempt, delayMs, error);
          },
        },
      ).catch((error: unknown) => {
        throw new ToolExecutionError(
          `Search failed: ${error instanceof Error ? error.message : 'unknown error'}. ` +
            'Try a different query, or answer from what you already have.',
        );
      });

      return { results: results.slice(0, maxResults) };
    },
  };
}

function logRetry(
  logger: Logger,
  provider: string,
  attempt: number,
  delayMs: number,
  error: unknown,
): void {
  logger.warn({ provider, attempt, delayMs, err: error }, 'search failed, retrying');
}
