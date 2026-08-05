import { sleep as realSleep } from './timeout.ts';
import { isTransient as defaultIsTransient, readFailure } from './transient.ts';

export interface RetryAttemptInfo {
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: unknown;
}

export interface RetryOptions {
  /** Total attempts including the first, so 3 means "try, retry, retry". */
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly signal?: AbortSignal;
  /** Injected so tests never wait: a fake sleep records the delay and returns. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected so the jitter is assertable rather than "roughly right". */
  readonly random?: () => number;
  readonly isTransient?: (error: unknown) => boolean;
  readonly onRetry?: (info: RetryAttemptInfo) => void;
}

const DEFAULTS = {
  attempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
} as const;

/**
 * Retries `fn` with exponential backoff and full jitter.
 *
 * Full jitter — a uniform pick from `[0, backoff]` rather than `backoff` itself —
 * because the failure mode worth designing for is many clients retrying a
 * recovering service in lockstep. Spreading the retries is the point; the delay
 * being "correct" is not.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  const isTransient = options.isTransient ?? defaultIsTransient;
  const { signal, onRetry } = options;

  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();

    try {
      return await fn(attempt);
    } catch (error) {
      // An abort is the caller saying stop. Retrying it would be insubordination.
      if (signal?.aborted === true) throw error;
      if (attempt >= attempts) throw error;
      if (!isTransient(error)) throw error;

      const delayMs = backoffDelay({ attempt, baseDelayMs, maxDelayMs, random, error });
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}

interface BackoffInput {
  readonly attempt: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly random: () => number;
  readonly error: unknown;
}

function backoffDelay({ attempt, baseDelayMs, maxDelayMs, random, error }: BackoffInput): number {
  // A server that tells us when to come back knows better than our backoff curve.
  const { retryAfterMs } = readFailure(error);
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, maxDelayMs);

  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}
