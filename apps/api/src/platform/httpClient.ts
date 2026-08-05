import axios, { type AxiosInstance } from 'axios';
import type { Readable } from 'node:stream';

/**
 * The narrowest possible view of "make one GET and give me the body as a stream".
 *
 * The point of the narrowness is testability: a fake is four lines, so the SSRF
 * matrix and the response-size cap are ordinary unit tests with no network, no
 * `msw`, and no casting a stub to `AxiosInstance`.
 */
export interface HttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Readable;
}

export interface HttpClient {
  get(request: HttpRequest): Promise<HttpResponse>;
}

export function createAxiosHttpClient(instance: AxiosInstance = axios.create()): HttpClient {
  return {
    get: async (request) => {
      const response = await instance.request<Readable>({
        url: request.url,
        method: 'GET',
        responseType: 'stream',
        headers: { ...request.headers },
        signal: request.signal,
        decompress: true,
        // Redirects are followed by the caller, one hop at a time, so that every
        // hop is re-checked against the SSRF policy. Axios would skip those checks.
        maxRedirects: 0,
        validateStatus: () => true,
      });

      return {
        status: response.status,
        headers: normaliseHeaders(response.headers),
        body: response.data,
      };
    },
  };
}

function normaliseHeaders(headers: unknown): Record<string, string | undefined> {
  if (typeof headers !== 'object' || headers === null) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      typeof value === 'string' ? value : undefined,
    ]),
  );
}
