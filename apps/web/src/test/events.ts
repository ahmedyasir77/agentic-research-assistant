import {
  AgentEventSchema,
  EVENT_SCHEMA_VERSION,
  type AgentEvent,
  type CitationGrounding,
} from '@ara/shared';

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

const QUOTE = 'scattering of light by particles much smaller than the wavelength';

/** The citation as the grounding check would have left it in each verdict. */
function citation(grounding: CitationGrounding): Record<string, unknown> {
  const base = {
    id: 1,
    url: 'https://en.wikipedia.org/wiki/Rayleigh_scattering',
    title: 'Rayleigh scattering — Wikipedia',
    grounding,
  };

  // Both verdicts that found the quote carry the passage it was found in; they
  // differ in whether that passage came from the page or from a search result.
  if (grounding === 'quoted' || grounding === 'snippet') {
    return {
      ...base,
      quote: QUOTE,
      quoteMatch: { before: 'Rayleigh scattering is the ', match: QUOTE, after: ' of the light.' },
    };
  }

  // A quote survives on the trace even when it failed — that is what gets shown.
  return grounding === 'unsupported' ? { ...base, quote: QUOTE } : base;
}

/** The shape of the recorded demo run, trimmed to one step. */
export function scriptedRun(
  overrides: { readonly citationGrounding?: CitationGrounding } = {},
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
      citations: [citation(overrides.citationGrounding ?? 'quoted')],
      warnings: [],
    }),
  ];
}
