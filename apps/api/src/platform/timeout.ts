/**
 * Every outbound call in this codebase has an explicit deadline. There are no
 * unbounded awaits, because an agent that hangs is worse than an agent that fails.
 */
export class TimeoutError extends Error {
  readonly timeoutMs: number;
  readonly label: string;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${String(timeoutMs)}ms`);
    this.name = 'TimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export interface TimeoutOptions {
  readonly timeoutMs: number;
  /** Appears in the error message and the trace, so make it name the operation. */
  readonly label: string;
  /** Caller's own cancellation — aborting it aborts the work too. */
  readonly signal?: AbortSignal;
}

/**
 * Runs `fn` with a deadline, handing it a signal that fires when the deadline
 * passes or the caller aborts.
 *
 * The result is also raced against the deadline rather than trusting `fn` to
 * honour the signal: a tool that ignores cancellation should be able to leak its
 * own work, but never to hang the run that called it.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: TimeoutOptions,
): Promise<T> {
  const { timeoutMs, label, signal: callerSignal } = options;

  if (callerSignal?.aborted === true) {
    throw abortReason(callerSignal);
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new TimeoutError(label, timeoutMs));
  }, timeoutMs);

  const signal =
    callerSignal === undefined ? deadline.signal : AbortSignal.any([callerSignal, deadline.signal]);

  try {
    return await Promise.race([fn(signal), rejectWhenAborted(signal)]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves never; rejects with whatever reason aborted the signal. */
function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(abortReason(signal));
      },
      { once: true },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  // `AbortSignal.reason` is typed `any`; narrowing it is the boundary check.
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('Aborted');
}

/** A cancellable delay, used as the default `sleep` for retries. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      },
      { once: true },
    );
  });
}
