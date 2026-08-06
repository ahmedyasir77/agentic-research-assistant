import axios, { type AxiosInstance } from 'axios';

/**
 * "POST this JSON and give me back whatever JSON came out."
 *
 * The counterpart to `HttpClient`, which is GET-and-stream for `http_get`. Both
 * are deliberately tiny: the vendor adapters above them are then testable against
 * a four-line fake, and the one place that knows about Axios stays one file.
 */
export interface JsonPostRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface JsonPostResponse {
  readonly status: number;
  readonly data: unknown;
}

export type JsonPoster = (request: JsonPostRequest) => Promise<JsonPostResponse>;

/**
 * Non-2xx responses are returned rather than thrown, because a provider's error
 * body is the most useful thing it sends — the adapter reads it and decides what
 * the model or the operator should be told.
 */
export function createAxiosJsonPoster(instance: AxiosInstance = axios.create()): JsonPoster {
  return async (request) => {
    const response = await instance.request<unknown>({
      url: request.url,
      method: 'POST',
      data: request.body,
      headers: { 'content-type': 'application/json', ...request.headers },
      timeout: request.timeoutMs,
      signal: request.signal,
      validateStatus: () => true,
      // Vendor APIs are single-origin JSON endpoints; a redirect from one is a
      // sign something is wrong, not something to follow.
      maxRedirects: 0,
    });

    return { status: response.status, data: response.data };
  };
}
