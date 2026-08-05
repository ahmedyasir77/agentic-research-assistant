import { describe, expect, it, vi } from 'vitest';

import { withRetry } from './retry.ts';
import { TimeoutError } from './timeout.ts';
import { isTransient, readFailure } from './transient.ts';

/** Records what the delay would have been, so the whole suite runs in microseconds. */
function recordingSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

function httpError(status: number, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`HTTP ${String(status)}`), { response: { status, headers } });
}

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const { delays, sleep } = recordingSleep();
    const result = await withRetry(() => Promise.resolve('ok'), { sleep });
    expect(result).toBe('ok');
    expect(delays).toStrictEqual([]);
  });

  it('retries transient failures up to the attempt cap, then rethrows', async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn(() => Promise.reject(httpError(503)));

    await expect(withRetry(fn, { sleep, attempts: 3, random: () => 1 })).rejects.toThrow(
      'HTTP 503',
    );
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
  });

  it('backs off exponentially, with full jitter picking from [0, ceiling]', async () => {
    const { delays, sleep } = recordingSleep();

    // random() === 1 is the top of the jitter window, so the delays are the
    // undiluted backoff curve: base, base*2, base*4.
    await expect(
      withRetry(() => Promise.reject(httpError(500)), {
        sleep,
        attempts: 4,
        baseDelayMs: 100,
        random: () => 1,
      }),
    ).rejects.toThrow();
    expect(delays).toStrictEqual([100, 200, 400]);

    // random() === 0 is the bottom of the same window. Both are valid full jitter.
    const zero = recordingSleep();
    await expect(
      withRetry(() => Promise.reject(httpError(500)), {
        sleep: zero.sleep,
        attempts: 4,
        baseDelayMs: 100,
        random: () => 0,
      }),
    ).rejects.toThrow();
    expect(zero.delays).toStrictEqual([0, 0, 0]);
  });

  it('caps the backoff at maxDelayMs', async () => {
    const { delays, sleep } = recordingSleep();
    await expect(
      withRetry(() => Promise.reject(httpError(500)), {
        sleep,
        attempts: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 2_500,
        random: () => 1,
      }),
    ).rejects.toThrow();
    expect(delays).toStrictEqual([1_000, 2_000, 2_500, 2_500]);
  });

  it('honours Retry-After in preference to its own backoff', async () => {
    const { delays, sleep } = recordingSleep();
    await expect(
      withRetry(() => Promise.reject(httpError(429, { 'retry-after': '2' })), {
        sleep,
        attempts: 2,
        baseDelayMs: 10_000,
        random: () => 1,
      }),
    ).rejects.toThrow();
    expect(delays).toStrictEqual([2_000]);
  });

  it('does not retry a non-transient failure', async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn(() => Promise.reject(httpError(400)));

    await expect(withRetry(fn, { sleep })).rejects.toThrow('HTTP 400');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toStrictEqual([]);
  });

  it('stops immediately when the caller aborts, without another attempt', async () => {
    const { sleep } = recordingSleep();
    const controller = new AbortController();
    const fn = vi.fn(() => {
      controller.abort();
      return Promise.reject(httpError(503));
    });

    await expect(withRetry(fn, { sleep, signal: controller.signal })).rejects.toThrow('HTTP 503');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when the signal is already aborted', async () => {
    const fn = vi.fn(() => Promise.resolve('never'));
    await expect(withRetry(fn, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports each retry so the run can be traced', async () => {
    const { sleep } = recordingSleep();
    const seen: number[] = [];

    await expect(
      withRetry(() => Promise.reject(httpError(500)), {
        sleep,
        attempts: 3,
        onRetry: ({ attempt }) => seen.push(attempt),
      }),
    ).rejects.toThrow();
    expect(seen).toStrictEqual([1, 2]);
  });

  it('succeeds after a transient failure', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const result = await withRetry(
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(httpError(500)) : Promise.resolve('recovered');
      },
      { sleep },
    );
    expect(result).toBe('recovered');
  });
});

describe('isTransient', () => {
  it.each([408, 429, 500, 502, 503, 504])('retries HTTP %i', (status) => {
    expect(isTransient(httpError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('does not retry HTTP %i', (status) => {
    expect(isTransient(httpError(status))).toBe(false);
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ERR_NETWORK'])('retries %s', (code) => {
    expect(isTransient(Object.assign(new Error(code), { code }))).toBe(true);
  });

  it('retries our own timeouts', () => {
    expect(isTransient(new TimeoutError('search', 100))).toBe(true);
  });

  it('does not retry an ordinary programming error', () => {
    expect(isTransient(new TypeError('undefined is not a function'))).toBe(false);
    expect(isTransient('a string')).toBe(false);
    expect(isTransient(null)).toBe(false);
  });
});

describe('readFailure', () => {
  it('reads Retry-After given in seconds', () => {
    expect(readFailure(httpError(429, { 'retry-after': '3' })).retryAfterMs).toBe(3_000);
  });

  it('reads Retry-After given as an HTTP date', () => {
    const now = Date.parse('2026-08-05T10:00:00.000Z');
    const error = httpError(503, { 'retry-after': 'Wed, 05 Aug 2026 10:00:30 GMT' });
    expect(readFailure(error, () => now).retryAfterMs).toBe(30_000);
  });

  it('ignores a Retry-After date that has already passed', () => {
    const now = Date.parse('2026-08-05T11:00:00.000Z');
    const error = httpError(503, { 'retry-after': 'Wed, 05 Aug 2026 10:00:00 GMT' });
    expect(readFailure(error, () => now).retryAfterMs).toBe(0);
  });

  it('ignores nonsense', () => {
    expect(readFailure(httpError(503, { 'retry-after': 'soon' })).retryAfterMs).toBeUndefined();
    expect(readFailure(undefined)).toStrictEqual({});
  });
});
