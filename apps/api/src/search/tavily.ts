import { z } from 'zod';

import type { Secret } from '../config/secret.ts';
import type { JsonPoster } from '../platform/jsonPost.ts';
import { SearchProviderError, type SearchProvider, type SearchResult } from './port.ts';

/**
 * Tavily's search API, mapped to the `SearchProvider` port.
 *
 * Like the model adapter, this is a translation layer and nothing else: it owns
 * the vendor's field names so that `web_search` — and the model reading its
 * results — never sees them.
 */
const DEFAULT_BASE_URL = 'https://api.tavily.com';

/** Comfortably inside the tool's own 10s timeout, so the tool reports the failure. */
const DEFAULT_TIMEOUT_MS = 8_000;

export interface TavilyDeps {
  readonly apiKey: Secret;
  readonly post: JsonPoster;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export function createTavilySearchProvider(deps: TavilyDeps): SearchProvider {
  const url = `${deps.baseUrl ?? DEFAULT_BASE_URL}/search`;

  return {
    name: 'tavily',

    search: async ({ query, maxResults, signal }) => {
      const response = await deps.post({
        url,
        headers: { authorization: `Bearer ${deps.apiKey.expose()}` },
        body: {
          query,
          max_results: maxResults,
          // "advanced" costs more credits and buys relevance the agent does not
          // need: it reads the promising page in full with `http_get` anyway.
          search_depth: 'basic',
          // The agent forms its own answer from sources it can cite, so Tavily's
          // synthesised answer would be an uncited claim in the middle of a run
          // whose entire point is checkable citations.
          include_answer: false,
        },
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal,
      });

      if (response.status !== 200) throw toSearchError(response.status, response.data);

      const parsed = ResponseSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new SearchProviderError('tavily', 'the response could not be read', {
          cause: parsed.error,
        });
      }

      return parsed.data.results.map(toSearchResult);
    },
  };
}

const ResultSchema = z.object({
  title: z.string(),
  url: z.url(),
  content: z.string(),
  /** Only present when `topic: news` is requested, which this adapter does not. */
  published_date: z.string().optional(),
});

const ResponseSchema = z.object({ results: z.array(ResultSchema) });

function toSearchResult(result: z.infer<typeof ResultSchema>): SearchResult {
  const publishedAt = toIsoDate(result.published_date);
  return {
    title: result.title,
    url: result.url,
    snippet: result.content,
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

/**
 * The port promises an ISO timestamp and Tavily sends whatever the page had. A
 * date that cannot be parsed is dropped rather than passed on — the field is
 * optional, and a wrong date is worse than no date.
 */
function toIsoDate(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

/** Tavily reports every failure as `{ detail: { error } }`. */
const ErrorBodySchema = z.object({ detail: z.object({ error: z.string() }) });

function toSearchError(status: number, data: unknown): SearchProviderError {
  const parsed = ErrorBodySchema.safeParse(data);
  const detail = parsed.success ? parsed.data.detail.error : 'no error detail was returned';
  return new SearchProviderError('tavily', `HTTP ${String(status)} — ${detail}`, { status });
}
