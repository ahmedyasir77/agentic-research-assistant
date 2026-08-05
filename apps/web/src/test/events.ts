import { AgentEventSchema, EVENT_SCHEMA_VERSION, type AgentEvent } from '@ara/shared';

/**
 * Test events built through the shared schema rather than as object literals, so a
 * test cannot assert against a shape the server could never send.
 */
const RUN_ID = 'run_test';

let seq = 0;

export function resetSeq(): void {
  seq = 0;
}

export function makeEvent(body: Record<string, unknown>): AgentEvent {
  const event = AgentEventSchema.parse({
    v: EVENT_SCHEMA_VERSION,
    seq,
    runId: RUN_ID,
    ts: new Date(seq * 1000).toISOString(),
    ...body,
  });
  seq += 1;
  return event;
}

export const BUDGETS = {
  maxSteps: 8,
  maxWallClockMs: 60_000,
  maxToolCallsPerStep: 3,
  maxOutputTokens: 4096,
} as const;

export const USAGE = { inputTokens: 1200, outputTokens: 300 } as const;

/** The shape of the recorded demo run, trimmed to one step. */
export function scriptedRun(
  overrides: { readonly citationVerified?: boolean } = {},
): readonly AgentEvent[] {
  resetSeq();
  return [
    makeEvent({
      type: 'run.started',
      query: 'Why is the sky blue?',
      budgets: BUDGETS,
      modelId: 'fake-model',
    }),
    makeEvent({ type: 'agent.step.started', step: 0 }),
    makeEvent({ type: 'agent.message', step: 0, text: 'I will search before answering.' }),
    makeEvent({
      type: 'tool.called',
      step: 0,
      callId: 'call_1',
      tool: 'web_search',
      args: { query: 'why is the sky blue', maxResults: 3 },
    }),
    makeEvent({
      type: 'tool.succeeded',
      step: 0,
      callId: 'call_1',
      tool: 'web_search',
      durationMs: 42,
      output: { results: [{ url: 'https://en.wikipedia.org/wiki/Rayleigh_scattering' }] },
    }),
    makeEvent({ type: 'answer.delta', text: 'Rayleigh scattering. [1]' }),
    makeEvent({
      type: 'run.completed',
      steps: 1,
      durationMs: 1234,
      usage: USAGE,
      estimatedCostUsd: 0.0135,
      answer: 'Rayleigh scattering. [1]',
      citations: [
        {
          id: 1,
          url: 'https://en.wikipedia.org/wiki/Rayleigh_scattering',
          title: 'Rayleigh scattering — Wikipedia',
          verified: overrides.citationVerified ?? true,
        },
      ],
      warnings: [],
    }),
  ];
}
