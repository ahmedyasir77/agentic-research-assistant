import { describe, expect, it } from 'vitest';

import { CreateRunRequestSchema, MAX_QUERY_LENGTH } from './api.ts';
import { AgentEventSchema, EVENT_SCHEMA_VERSION } from './events.ts';
import { JsonValueSchema } from './json.ts';
import { RunOutcomeSchema, RunTraceSchema, TRACE_SCHEMA_VERSION } from './trace.ts';

const envelope = {
  v: EVENT_SCHEMA_VERSION,
  seq: 0,
  runId: 'run_1',
  ts: '2026-08-05T10:00:00.000Z',
};

describe('AgentEvent', () => {
  it('accepts a well-formed event of each type', () => {
    const events = [
      {
        ...envelope,
        type: 'run.started',
        query: 'why is the sky blue',
        modelId: 'claude-opus-5',
        budgets: {
          maxSteps: 8,
          maxWallClockMs: 60_000,
          maxToolCallsPerStep: 3,
          maxOutputTokens: 4096,
        },
      },
      { ...envelope, type: 'agent.step.started', step: 0 },
      { ...envelope, type: 'agent.message', step: 0, text: 'I should search first.' },
      { ...envelope, type: 'tool.called', step: 0, callId: 'c1', tool: 'web_search', args: {} },
      {
        ...envelope,
        type: 'tool.succeeded',
        step: 0,
        callId: 'c1',
        tool: 'web_search',
        durationMs: 12,
        output: { results: [] },
      },
      {
        ...envelope,
        type: 'tool.failed',
        step: 0,
        callId: 'c1',
        tool: 'http_get',
        durationMs: 12,
        error: { kind: 'timeout', message: 'took longer than 5000ms' },
      },
      { ...envelope, type: 'answer.delta', text: 'Because of Rayleigh scattering.' },
    ];

    for (const event of events) {
      expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    }
  });

  it('rejects an event whose type is not in the union', () => {
    const result = AgentEventSchema.safeParse({ ...envelope, type: 'run.exploded' });
    expect(result.success).toBe(false);
  });

  it('rejects an event from a future contract version', () => {
    const result = AgentEventSchema.safeParse({
      ...envelope,
      v: EVENT_SCHEMA_VERSION + 1,
      type: 'agent.step.started',
      step: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('RunTrace', () => {
  it('round-trips a completed run', () => {
    const trace = {
      v: TRACE_SCHEMA_VERSION,
      runId: 'run_1',
      query: 'why is the sky blue',
      status: 'succeeded',
      outcome: 'completed',
      modelId: 'claude-opus-5',
      budgets: {
        maxSteps: 8,
        maxWallClockMs: 60_000,
        maxToolCallsPerStep: 3,
        maxOutputTokens: 4096,
      },
      startedAt: '2026-08-05T10:00:00.000Z',
      endedAt: '2026-08-05T10:00:04.000Z',
      durationMs: 4000,
      steps: [],
      answer: 'Rayleigh scattering. [1]',
      citations: [{ id: 1, url: 'https://example.com/optics', title: 'Optics', verified: true }],
      warnings: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      estimatedCostUsd: 0.00175,
    };

    expect(RunTraceSchema.parse(trace)).toStrictEqual(trace);
  });

  it('rejects a citation whose url is not a url', () => {
    const result = RunTraceSchema.shape.citations.safeParse([
      { id: 1, url: 'not-a-url', title: 'Optics', verified: false },
    ]);
    expect(result.success).toBe(false);
  });
});

describe('RunOutcome', () => {
  it('covers success plus every failure reason, because it labels a metric', () => {
    expect(RunOutcomeSchema.options).toStrictEqual([
      'completed',
      'budget_exceeded',
      'no_tool_call',
      'llm_error',
      'internal_error',
    ]);
  });
});

describe('CreateRunRequest', () => {
  it('trims and accepts a real question', () => {
    expect(CreateRunRequestSchema.parse({ query: '  why is the sky blue  ' })).toStrictEqual({
      query: 'why is the sky blue',
    });
  });

  it('rejects a query longer than the ingress cap', () => {
    const result = CreateRunRequestSchema.safeParse({ query: 'x'.repeat(MAX_QUERY_LENGTH + 1) });
    expect(result.success).toBe(false);
  });
});

describe('JsonValue', () => {
  it('accepts nested JSON', () => {
    const value = { a: [1, 'two', true, null, { b: {} }] };
    expect(JsonValueSchema.parse(value)).toStrictEqual(value);
  });

  it('rejects values that cannot survive a round trip through JSON', () => {
    expect(JsonValueSchema.safeParse({ when: new Date() }).success).toBe(false);
    expect(JsonValueSchema.safeParse({ fn: () => undefined }).success).toBe(false);
  });
});
