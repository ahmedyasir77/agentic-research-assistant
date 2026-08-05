import { z } from 'zod';

/**
 * The seam between "the agent searches the web" and "which search company we pay".
 * `tavily.ts` calls a real API; `fixture.ts` reads recorded JSON so the demo runs
 * with no network and no key. Nothing above this line knows which one is in use.
 */
export const SearchResultSchema = z.object({
  title: z.string(),
  url: z.url(),
  snippet: z.string(),
  publishedAt: z.iso.datetime().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export interface SearchRequest {
  readonly query: string;
  readonly maxResults: number;
  readonly signal: AbortSignal;
}

export interface SearchProvider {
  /** Appears in logs and the trace, so a run says which provider answered it. */
  readonly name: string;
  search(request: SearchRequest): Promise<readonly SearchResult[]>;
}

/** Raised when a provider fails in a way the agent should be told about. */
export class SearchProviderError extends Error {
  constructor(provider: string, message: string, options?: { cause?: unknown }) {
    super(`${provider} search failed: ${message}`, options);
    this.name = 'SearchProviderError';
  }
}
