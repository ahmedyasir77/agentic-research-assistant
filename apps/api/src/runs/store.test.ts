import { RunTraceSchema, type RunTrace } from '@ara/shared';
import { describe, expect, it } from 'vitest';

import { RunCapacityError, RunStore } from './store.ts';

function trace(runId: string, status: 'succeeded' | 'failed' = 'succeeded'): RunTrace {
  return RunTraceSchema.parse({
    v: 1,
    runId,
    query: 'anything',
    status,
    outcome: status === 'succeeded' ? 'completed' : 'budget_exceeded',
    budgets: { maxSteps: 8, maxWallClockMs: 60_000, maxToolCallsPerStep: 3, maxOutputTokens: 4096 },
    modelId: 'fake-model',
    startedAt: new Date(0).toISOString(),
    durationMs: 1,
    steps: [],
    citations: [],
    warnings: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
  });
}

describe('RunStore', () => {
  it('hands back a run that is running until it is given a trace', () => {
    const store = new RunStore();
    const record = store.create('why is the sky blue');

    expect(record.status).toBe('running');
    expect(store.running).toHaveLength(1);

    record.finish(trace(record.runId));

    expect(record.status).toBe('succeeded');
    expect(store.get(record.runId)?.trace?.runId).toBe(record.runId);
    expect(store.running).toStrictEqual([]);
  });

  it('resolves whenFinished so shutdown has something to wait on', async () => {
    const store = new RunStore();
    const record = store.create('anything');

    record.finish(trace(record.runId));

    await expect(record.whenFinished).resolves.toBeUndefined();
  });

  it('reports a run that ended without a trace as failed rather than running', () => {
    const store = new RunStore();
    const record = store.create('anything');

    record.finish();

    expect(record.status).toBe('failed');
    expect(record.trace).toBeUndefined();
    expect(store.running).toStrictEqual([]);
  });

  it('forgets a finished run once its time is up', () => {
    let now = 0;
    const store = new RunStore({ ttlMs: 1_000, now: () => now });
    const record = store.create('anything');
    record.finish(trace(record.runId));

    now = 999;
    expect(store.get(record.runId)).toBeDefined();

    now = 1_001;
    expect(store.get(record.runId)).toBeUndefined();
  });

  it('keeps a run that is still going, however old it is', () => {
    let now = 0;
    const store = new RunStore({ ttlMs: 1_000, now: () => now });
    const record = store.create('anything');

    now = 10_000;

    // Evicting a live run would strand every client subscribed to its stream.
    expect(store.get(record.runId)).toBe(record);
  });

  it('evicts the oldest finished run to make room for a new one', () => {
    const store = new RunStore({ maxRuns: 2 });
    const oldest = store.create('first');
    const middle = store.create('second');
    oldest.finish(trace(oldest.runId));
    middle.finish(trace(middle.runId));

    store.create('third');

    expect(store.get(oldest.runId)).toBeUndefined();
    expect(store.get(middle.runId)).toBeDefined();
    expect(store.size).toBe(2);
  });

  it('refuses a new run when the cap is full of runs still going', () => {
    const store = new RunStore({ maxRuns: 1 });
    store.create('first');

    // Backpressure rather than unbounded memory: there is nothing safe to evict.
    expect(() => store.create('second')).toThrow(RunCapacityError);
  });
});
