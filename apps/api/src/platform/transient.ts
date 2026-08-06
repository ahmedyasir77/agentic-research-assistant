import { z } from 'zod';

import { TimeoutError } from './timeout.ts';

/**
 * Deciding what is worth retrying. Retrying a 400 just makes the same mistake
 * three times more slowly, so the rule is: retry things that might succeed on
 * their own — congestion, timeouts, a server having a bad moment — and nothing else.
 */

/** Network-level failures that say nothing about whether the request was valid. */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETRESET',
  'EHOSTUNREACH',
  'ERR_NETWORK',
]);

/**
 * Errors arrive as `unknown` and their shape belongs to whichever library threw.
 * Rather than casting, the interesting fields are parsed out — the same rule the
 * rest of the codebase follows at every other boundary.
 */
const HttpFailureSchema = z.object({
  code: z.string().optional(),
  status: z.number().int().optional(),
  response: z
    .object({
      status: z.number().int(),
      headers: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export interface FailureFacts {
  readonly code?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
}

export function readFailure(error: unknown, now: () => number = Date.now): FailureFacts {
  if (typeof error !== 'object' || error === null) return {};

  const parsed = HttpFailureSchema.safeParse(error);
  if (!parsed.success) return {};

  const status = parsed.data.response?.status ?? parsed.data.status;
  if (parsed.data.code === undefined && status === undefined) {
    // An adapter that wraps a provider failure in its own error type still has to
    // be classifiable, so the facts are looked for one level down as well.
    return readCause(error, now);
  }
  const retryAfterMs = parseRetryAfter(parsed.data.response?.headers?.['retry-after'], now);

  return {
    ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }),
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

const CauseSchema = z.object({ cause: z.unknown() });

function readCause(error: object, now: () => number): FailureFacts {
  const parsed = CauseSchema.safeParse(error);
  const cause = parsed.success ? parsed.data.cause : undefined;
  return cause === undefined || cause === error ? {} : readFailure(cause, now);
}

/** RFC 9110 allows either delay-seconds or an HTTP-date; servers use both. */
function parseRetryAfter(header: unknown, now: () => number): number | undefined {
  if (typeof header !== 'string' || header.trim() === '') return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? seconds * 1000 : 0;
  }

  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now());
}

export function isTransient(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;

  const { code, status } = readFailure(error);
  if (code !== undefined && TRANSIENT_ERROR_CODES.has(code)) return true;
  if (status === undefined) return false;

  // 408 Request Timeout and 429 Too Many Requests are explicit "try again"
  // signals; 5xx means the server failed, not that we asked wrongly.
  return status === 408 || status === 429 || status >= 500;
}
