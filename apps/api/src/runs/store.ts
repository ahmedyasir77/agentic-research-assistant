import { randomUUID } from 'node:crypto';

import type { RunStatus, RunTrace } from '@ara/shared';

import { RunEmitter } from './emitter.ts';

/**
 * One run: its events while it is happening, and its trace once it is over.
 *
 * `status` is read off the trace rather than tracked alongside it, so there is no
 * second copy of the truth to keep in sync.
 */
export class RunRecord {
  readonly runId: string;
  readonly query: string;
  readonly createdAtMs: number;
  readonly emitter = new RunEmitter();

  /** Resolves when the run ends, however it ends. Shutdown waits on these. */
  readonly whenFinished: Promise<void>;

  readonly #markFinished: () => void;
  #trace: RunTrace | undefined;
  #finished = false;

  constructor(init: { runId: string; query: string; createdAtMs: number }) {
    this.runId = init.runId;
    this.query = init.query;
    this.createdAtMs = init.createdAtMs;

    // Assigned synchronously by the executor; the no-op keeps the compiler happy
    // without a definite-assignment assertion.
    let markFinished = (): void => undefined;
    this.whenFinished = new Promise((resolve) => {
      markFinished = resolve;
    });
    this.#markFinished = markFinished;
  }

  get trace(): RunTrace | undefined {
    return this.#trace;
  }

  get status(): RunStatus {
    return this.#trace?.status ?? (this.#finished ? 'failed' : 'running');
  }

  /**
   * Called with no trace only when the agent loop broke its own contract and
   * threw. The run still has to end — a subscriber holding an open stream that
   * never closes is a worse failure than a missing trace.
   */
  finish(trace?: RunTrace): void {
    this.#trace = trace;
    this.#finished = true;
    this.emitter.close();
    this.#markFinished();
  }
}

/**
 * Refused rather than queued: the store is bounded, and when the bound is full of
 * runs that are still going there is nothing to evict. Shedding load at the door
 * is more honest than growing until the container is OOM-killed.
 */
export class RunCapacityError extends Error {
  constructor(maxRuns: number) {
    super(`Already running ${String(maxRuns)} runs. Try again in a moment.`);
    this.name = 'RunCapacityError';
  }
}

export interface RunStoreOptions {
  /** Total runs held, finished and in flight. */
  readonly maxRuns?: number;
  /** How long a finished run stays replayable. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * Runs live in memory, with a TTL and a size cap.
 *
 * A deliberate scope choice: there is no database, so a restart loses history and
 * a second instance cannot serve a run the first one started. What would change
 * for a multi-instance deployment is the storage, not the shape — the trace is
 * already a serialisable document, and events already carry a sequence number, so
 * this becomes a Redis stream keyed by `runId` with the same two operations.
 */
export class RunStore {
  readonly #runs = new Map<string, RunRecord>();
  readonly #maxRuns: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: RunStoreOptions = {}) {
    this.#maxRuns = options.maxRuns ?? 100;
    this.#ttlMs = options.ttlMs ?? 15 * 60_000;
    this.#now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.#runs.size;
  }

  get running(): readonly RunRecord[] {
    return [...this.#runs.values()].filter((record) => record.status === 'running');
  }

  create(query: string): RunRecord {
    this.#dropExpired();
    this.#makeRoom();
    if (this.#runs.size >= this.#maxRuns) throw new RunCapacityError(this.#maxRuns);

    const record = new RunRecord({
      runId: `run_${randomUUID()}`,
      query,
      createdAtMs: this.#now(),
    });
    this.#runs.set(record.runId, record);
    return record;
  }

  get(runId: string): RunRecord | undefined {
    this.#dropExpired();
    return this.#runs.get(runId);
  }

  /**
   * Expiry is swept on read and on write rather than on a timer: a background
   * interval would keep the event loop alive and make shutdown a negotiation, and
   * a run nobody asks for costs nothing by lingering a little longer.
   */
  #dropExpired(): void {
    const deadline = this.#now() - this.#ttlMs;
    for (const [runId, record] of this.#runs) {
      if (record.status !== 'running' && record.createdAtMs < deadline) this.#runs.delete(runId);
    }
  }

  /**
   * Insertion order gives eviction for free — `Map` preserves it, so the oldest
   * runs are the ones seen first. Runs still in flight are never evicted; their
   * subscribers would be left holding a stream that could never end.
   */
  #makeRoom(): void {
    for (const [runId, record] of this.#runs) {
      if (this.#runs.size < this.#maxRuns) return;
      if (record.status !== 'running') this.#runs.delete(runId);
    }
  }
}
