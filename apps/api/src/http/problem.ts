import type { ProblemDetails } from '@ara/shared';

/**
 * Every error this API returns is one of these, serialised as RFC 9457
 * `application/problem+json`. One shape means the browser has one thing to parse
 * and one thing to render, and it means a handler can throw instead of writing an
 * error response by hand — see `middleware/errorHandler.ts`.
 */
export class ProblemError extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(init: {
    status: number;
    title: string;
    type: string;
    detail: string;
    headers?: Readonly<Record<string, string>>;
  }) {
    super(init.detail);
    this.name = 'ProblemError';
    this.status = init.status;
    this.title = init.title;
    this.type = init.type;
    this.headers = init.headers ?? {};
  }

  toProblemDetails(instance: string): ProblemDetails {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.message,
      instance,
    };
  }
}

/**
 * The problem types this API can return. Relative URIs, which RFC 9457 permits —
 * inventing a domain to host documentation that does not exist would be worse.
 */
export const problem = {
  badRequest: (detail: string): ProblemError =>
    new ProblemError({
      status: 400,
      title: 'The request was not valid.',
      type: '/problems/invalid-request',
      detail,
    }),

  notFound: (detail: string): ProblemError =>
    new ProblemError({
      status: 404,
      title: 'No such run.',
      type: '/problems/run-not-found',
      detail,
    }),

  stillRunning: (detail: string): ProblemError =>
    new ProblemError({
      status: 409,
      title: 'The run has not finished.',
      type: '/problems/run-in-progress',
      detail,
    }),

  alreadyFinished: (detail: string): ProblemError =>
    new ProblemError({
      status: 409,
      title: 'The run has already finished.',
      type: '/problems/run-already-finished',
      detail,
    }),

  payloadTooLarge: (detail: string): ProblemError =>
    new ProblemError({
      status: 413,
      title: 'The request body was too large.',
      type: '/problems/body-too-large',
      detail,
    }),

  rateLimited: (detail: string, retryAfterSeconds: number): ProblemError =>
    new ProblemError({
      status: 429,
      title: 'Too many runs.',
      type: '/problems/rate-limited',
      detail,
      headers: { 'retry-after': String(retryAfterSeconds) },
    }),

  noTrace: (detail: string): ProblemError =>
    new ProblemError({
      status: 500,
      title: 'The run left no trace.',
      type: '/problems/run-crashed',
      detail,
    }),

  atCapacity: (detail: string): ProblemError =>
    new ProblemError({
      status: 503,
      title: 'The service is at capacity.',
      type: '/problems/at-capacity',
      detail,
      headers: { 'retry-after': '10' },
    }),
} as const;
