import type { RequestHandler } from 'express';

import { problem } from '../problem.ts';

const WINDOW_MS = 60_000;

/**
 * How many callers are tracked before the table is swept. Bounded because the key
 * is client-controlled: an unbounded map keyed by remote address is a memory leak
 * with a nice name.
 */
const MAX_TRACKED_CLIENTS = 10_000;

export interface RateLimitOptions {
  readonly limitPerMinute: number;
  /** Injected so the window boundary is a test assertion rather than a sleep. */
  readonly now?: () => number;
}

interface Window {
  startedAtMs: number;
  count: number;
}

/**
 * A fixed-window limiter on run creation, held in this process's memory.
 *
 * Starting a run costs model tokens, so this is the only endpoint that needs one.
 * Fixed windows let a caller burst across a boundary; a sliding window would be
 * stricter, and with one instance and a 10/minute default the difference does not
 * matter. What would matter at multiple instances is that this counter is
 * per-process — the limit would have to move to a shared store.
 */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, Window>();

  return (req, _res, next) => {
    const at = now();
    if (windows.size >= MAX_TRACKED_CLIENTS) sweep(windows, at);

    const key = req.ip ?? 'unknown';
    const current = windows.get(key);

    if (current === undefined || at - current.startedAtMs >= WINDOW_MS) {
      windows.set(key, { startedAtMs: at, count: 1 });
      next();
      return;
    }

    current.count += 1;
    if (current.count > options.limitPerMinute) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((current.startedAtMs + WINDOW_MS - at) / 1_000),
      );
      next(
        problem.rateLimited(
          `You can start ${String(options.limitPerMinute)} runs per minute. Wait ${String(retryAfterSeconds)}s and try again.`,
          retryAfterSeconds,
        ),
      );
      return;
    }

    next();
  };
}

function sweep(windows: Map<string, Window>, at: number): void {
  for (const [key, window] of windows) {
    if (at - window.startedAtMs >= WINDOW_MS) windows.delete(key);
  }
}
