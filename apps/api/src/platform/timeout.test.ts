import { describe, expect, it, vi } from 'vitest';

import { sleep, TimeoutError, withTimeout } from './timeout.ts';

describe('withTimeout', () => {
  it('returns the value when the work finishes in time', async () => {
    const result = await withTimeout(() => Promise.resolve('done'), {
      timeoutMs: 1_000,
      label: 'fast work',
    });
    expect(result).toBe('done');
  });

  it('rejects with a TimeoutError naming the operation', async () => {
    const promise = withTimeout(() => new Promise<never>(() => undefined), {
      timeoutMs: 5,
      label: 'tool web_search',
    });
    await expect(promise).rejects.toThrow(TimeoutError);
    await expect(promise).rejects.toThrow(/tool web_search timed out after 5ms/u);
  });

  it('gives the work a signal that fires on the deadline', async () => {
    let observed: AbortSignal | undefined;
    await expect(
      withTimeout(
        (signal) => {
          observed = signal;
          return new Promise<never>(() => undefined);
        },
        { timeoutMs: 5, label: 'work' },
      ),
    ).rejects.toThrow(TimeoutError);
    expect(observed?.aborted).toBe(true);
  });

  it('does not hang when the work ignores its signal', async () => {
    // The point of racing rather than trusting the callee: a badly behaved tool
    // can leak its own work, but it cannot hold up the run.
    const stubborn = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve('late');
        }, 5_000);
      });
    await expect(withTimeout(stubborn, { timeoutMs: 5, label: 'stubborn' })).rejects.toThrow(
      TimeoutError,
    );
  });

  it('propagates the work’s own failure unchanged', async () => {
    await expect(
      withTimeout(() => Promise.reject(new RangeError('bad input')), {
        timeoutMs: 1_000,
        label: 'work',
      }),
    ).rejects.toThrow(RangeError);
  });

  it('aborts when the caller aborts, before the deadline', async () => {
    const controller = new AbortController();
    const promise = withTimeout((signal) => sleep(5_000, signal), {
      timeoutMs: 5_000,
      label: 'work',
      signal: controller.signal,
    });
    controller.abort(new Error('caller changed their mind'));
    await expect(promise).rejects.toThrow('caller changed their mind');
  });

  it('refuses to start when the caller has already aborted', async () => {
    const work = vi.fn(() => Promise.resolve('never'));
    await expect(
      withTimeout(work, { timeoutMs: 1_000, label: 'work', signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
  });

  it('clears its timer so a finished call cannot keep the process alive', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    await withTimeout(() => Promise.resolve(1), { timeoutMs: 1_000, label: 'work' });
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const startedAt = Date.now();
    await sleep(10);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(8);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    await expect(sleep(5_000, AbortSignal.abort())).rejects.toThrow();
  });

  it('rejects as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const promise = sleep(5_000, controller.signal);
    controller.abort(new Error('stop waiting'));
    await expect(promise).rejects.toThrow('stop waiting');
  });
});
