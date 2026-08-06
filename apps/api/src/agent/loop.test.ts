import { Readable } from 'node:stream';
import type { AgentEvent, RunTrace } from '@ara/shared';
import { describe, expect, it } from 'vitest';

import { createFakeLlmClient, turn, type FakeLlmClient } from '../llm/fake.ts';
import { LlmError, type LlmResponse } from '../llm/port.ts';
import type { HttpClient } from '../platform/httpClient.ts';
import { silentLogger } from '../platform/logger.ts';
import type { SearchProvider } from '../search/port.ts';
import { createToolRegistry } from '../tools/index.ts';
import { runAgent } from './loop.ts';
import { DEFAULT_POLICY, type AgentPolicy } from './policy.ts';
import type { AgentDeps, Clock } from './types.ts';

/**
 * Six scenarios, no network, no API key, no randomness. A reason-act loop is
 * non-deterministic in production precisely because a model decides what happens
 * next — so the model is the thing that gets replaced with a script, and every
 * branch of the loop becomes an ordinary assertion.
 */

const SOURCE = 'https://example.com/optics';
const OTHER_SOURCE = 'https://example.com/scattering';

const searchProvider: SearchProvider = {
  name: 'test',
  search: () =>
    Promise.resolve([
      { title: 'Optics', url: SOURCE, snippet: 'Blue scatters more.' },
      { title: 'Scattering', url: OTHER_SOURCE, snippet: 'Inverse fourth power.' },
    ]),
};

const http: HttpClient = {
  get: () =>
    Promise.resolve({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Readable.from(['<p>Blue light scatters about 5.5 times more than red.</p>']),
    }),
};

/** A clock that advances a fixed amount per read, so durations are exact values. */
function fakeClock(stepMs = 10): Clock {
  let current = Date.parse('2026-08-05T10:00:00.000Z');
  return {
    now: () => {
      const value = current;
      current += stepMs;
      return value;
    },
  };
}

function deps(
  turns: readonly LlmResponse[],
  overrides: { policy?: Partial<AgentPolicy>; clock?: Clock; llm?: FakeLlmClient } = {},
): AgentDeps {
  return {
    runId: 'run_test',
    llm: overrides.llm ?? createFakeLlmClient(turns),
    tools: createToolRegistry({
      searchProvider,
      http: { http, resolveDns: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]) },
      registry: { now: () => 0 },
    }),
    policy: { ...DEFAULT_POLICY, ...overrides.policy },
    clock: overrides.clock ?? fakeClock(),
    logger: silentLogger,
  };
}

/** Drives the generator to completion and keeps both the events and the trace. */
async function run(
  query: string,
  agentDeps: AgentDeps,
): Promise<{ events: AgentEvent[]; trace: RunTrace }> {
  const events: AgentEvent[] = [];
  const iterator = runAgent(query, agentDeps);

  for (;;) {
    const next = await iterator.next();
    if (next.done === true) return { events, trace: next.value };
    events.push(next.value);
  }
}

const types = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type);

const finishCall = (answer: string, urls: readonly string[]) =>
  turn.toolCall([
    {
      id: 'call_finish',
      name: 'finish',
      input: {
        answer,
        citations: urls.map((url, index) => ({
          id: index + 1,
          url,
          title: `Source ${String(index + 1)}`,
        })),
      },
    },
  ]);

describe('scenario 1 — the happy path', () => {
  it('searches, reads, and answers with verified citations', async () => {
    const agentDeps = deps([
      turn.toolCall([{ id: 'c1', name: 'web_search', input: { query: 'why is the sky blue' } }], {
        text: 'I will search first.',
      }),
      turn.toolCall([{ id: 'c2', name: 'http_get', input: { url: SOURCE } }], {
        text: 'Now I will read the best source.',
      }),
      finishCall('Blue light scatters more. [1]', [SOURCE]),
    ]);

    const { events, trace } = await run('why is the sky blue', agentDeps);

    expect(trace.status).toBe('succeeded');
    expect(trace.outcome).toBe('completed');
    expect(trace.answer).toBe('Blue light scatters more. [1]');
    expect(trace.citations).toStrictEqual([
      { id: 1, url: SOURCE, title: 'Source 1', verified: true },
    ]);
    expect(trace.warnings).toStrictEqual([]);
    expect(trace.steps).toHaveLength(3);

    expect(types(events)).toStrictEqual([
      'run.started',
      'agent.step.started',
      'agent.message',
      'tool.called',
      'tool.succeeded',
      'agent.step.started',
      'agent.message',
      'tool.called',
      'tool.succeeded',
      'agent.step.started',
      'tool.called',
      'tool.succeeded',
      'answer.delta',
      'run.completed',
    ]);
  });

  it('numbers events so a reconnecting client can tell what it missed', async () => {
    const agentDeps = deps([finishCall('Done.', [])]);
    const { events } = await run('anything', agentDeps);

    expect(events.map((event) => event.seq)).toStrictEqual(events.map((_event, index) => index));
  });

  it('runs tools the model requested together in parallel', async () => {
    const agentDeps = deps([
      turn.toolCall([
        { id: 'c1', name: 'calculator', input: { expression: '2 + 2' } },
        { id: 'c2', name: 'calculator', input: { expression: '3 * 3' } },
      ]),
      finishCall('Four and nine.', []),
    ]);

    const { events } = await run('do some sums', agentDeps);
    const calledOnFirstStep = events.filter(
      (event) => event.type === 'tool.called' && event.step === 0,
    );
    expect(calledOnFirstStep).toHaveLength(2);
  });
});

describe('scenario 2 — malformed tool arguments', () => {
  it('hands the model its own error and lets it correct itself', async () => {
    const agentDeps = deps([
      // `query` must be a string; the model sends a number.
      turn.toolCall([{ id: 'c1', name: 'web_search', input: { query: 42 } }]),
      turn.toolCall([{ id: 'c2', name: 'web_search', input: { query: 'why is the sky blue' } }]),
      finishCall('Corrected and answered. [1]', [SOURCE]),
    ]);

    const { events, trace } = await run('why is the sky blue', agentDeps);

    const failure = events.find((event) => event.type === 'tool.failed');
    expect(failure?.type === 'tool.failed' && failure.error.kind).toBe('invalid_arguments');

    // The run still succeeds — a bad tool call is a turn, not a crash.
    expect(trace.status).toBe('succeeded');
    expect(trace.warnings.map((warning) => warning.kind)).toContain('invalid_tool_arguments');
  });

  it('recovers from a tool name the model invented', async () => {
    const agentDeps = deps([
      turn.toolCall([{ id: 'c1', name: 'summon_daemon', input: {} }]),
      finishCall('Recovered.', []),
    ]);

    const { events, trace } = await run('anything', agentDeps);

    const failure = events.find((event) => event.type === 'tool.failed');
    expect(failure?.type === 'tool.failed' && failure.error.kind).toBe('unknown_tool');
    expect(trace.status).toBe('succeeded');
  });

  it('treats a finish call with invalid arguments as unfinished', async () => {
    const agentDeps = deps([
      // A citation whose url is not a url. Omitting the citations array entirely
      // is deliberately *not* an error any more — see ADR-029.
      turn.toolCall([
        {
          id: 'c1',
          name: 'finish',
          input: { answer: 'Bad citation.', citations: [{ id: 1, url: 'nope', title: 'x' }] },
        },
      ]),
      finishCall('Second attempt, properly formed.', []),
    ]);

    const { trace } = await run('anything', agentDeps);

    expect(trace.status).toBe('succeeded');
    expect(trace.answer).toBe('Second attempt, properly formed.');
    expect(trace.steps).toHaveLength(2);
  });
});

describe('scenario 3 — the step budget', () => {
  it('stops at the limit and returns what it had', async () => {
    const searching = turn.toolCall([{ id: 'c', name: 'web_search', input: { query: 'more' } }], {
      text: 'Still looking.',
    });
    const agentDeps = deps([searching, searching, searching, searching], {
      policy: { maxSteps: 3 },
    });

    const { events, trace } = await run('an unanswerable question', agentDeps);

    expect(trace.status).toBe('failed');
    expect(trace.outcome).toBe('budget_exceeded');
    expect(trace.steps).toHaveLength(3);
    expect(trace.failureMessage).toContain('3 steps');

    // Not empty-handed: the last thing the model said comes back as a partial answer.
    expect(trace.answer).toBe('Still looking.');
    const failed = events.at(-1);
    expect(failed?.type).toBe('run.failed');
    expect(failed?.type === 'run.failed' && failed.partialAnswer).toBe('Still looking.');
  });

  it('never spends a model call it cannot afford', async () => {
    const searching = turn.toolCall([{ id: 'c', name: 'web_search', input: { query: 'more' } }]);
    const llm = createFakeLlmClient([searching, searching, searching, searching, searching]);
    const agentDeps = deps([], { policy: { maxSteps: 2 }, llm });

    await run('anything', agentDeps);

    // Budget is checked before the call, so exactly maxSteps calls were made.
    expect(llm.requests).toHaveLength(2);
  });
});

describe('scenario 4 — the wall clock', () => {
  it('stops when the elapsed time budget is spent', async () => {
    // Each clock read jumps 400ms, so the run is out of time within a few steps.
    const searching = turn.toolCall([{ id: 'c', name: 'web_search', input: { query: 'more' } }]);
    const agentDeps = deps([searching, searching, searching, searching, searching, searching], {
      policy: { maxSteps: 50, maxWallClockMs: 1_000 },
      clock: fakeClock(400),
    });

    const { trace } = await run('a slow question', agentDeps);

    expect(trace.status).toBe('failed');
    expect(trace.outcome).toBe('budget_exceeded');
    expect(trace.failureMessage).toMatch(/time limit/u);
    expect(trace.steps.length).toBeLessThan(50);
  });

  it('gives the model and the tools a signal that fires on the deadline', async () => {
    let observed: AbortSignal | undefined;
    const llm = createFakeLlmClient([finishCall('Done.', [])], {
      onRequest: (request) => {
        observed = request.signal;
      },
    });
    const agentDeps = deps([], { llm });

    await run('anything', agentDeps);
    expect(observed).toBeDefined();
    expect(observed?.aborted).toBe(false);
  });
});

describe('scenario 5 — the model will not call finish', () => {
  it('nudges once, then stops rather than looping forever', async () => {
    const agentDeps = deps([
      turn.text('The sky is blue because of scattering.'),
      turn.text('I already told you: scattering.'),
    ]);

    const { events, trace } = await run('why is the sky blue', agentDeps);

    expect(trace.status).toBe('failed');
    expect(trace.outcome).toBe('no_tool_call');
    expect(trace.answer).toBe('I already told you: scattering.');
    expect(trace.warnings.map((warning) => warning.kind)).toContain('missing_finish_call');

    // Two model calls, two messages, one failure — no third attempt.
    expect(events.filter((event) => event.type === 'agent.message')).toHaveLength(2);
  });

  it('accepts a finish call made after the nudge', async () => {
    const agentDeps = deps([
      turn.text('The sky is blue because of scattering.'),
      finishCall('The sky is blue because of scattering. [1]', [SOURCE]),
    ]);

    const { trace } = await run('why is the sky blue', agentDeps);
    expect(trace.status).toBe('succeeded');
  });

  it('does not warn about a nudge the model took', async () => {
    // No citations, so the only warning this run could produce is the nudge one.
    const agentDeps = deps([
      turn.text('The sky is blue because of scattering.'),
      finishCall('The sky is blue because of scattering.', []),
    ]);

    const { trace } = await run('why is the sky blue', agentDeps);

    // A warning means the answer is less trustworthy than it looks. A model that
    // was corrected once and complied cost a step — which the trace shows — and
    // changed nothing about the answer.
    expect(trace.warnings).toStrictEqual([]);
  });

  it('counts the nudged turn as a step, in the trace as well as the stream', async () => {
    const agentDeps = deps([
      turn.text('The sky is blue because of scattering.'),
      finishCall('The sky is blue because of scattering. [1]', [SOURCE]),
    ]);

    const { events, trace } = await run('why is the sky blue', agentDeps);

    // The trace and the event stream have to agree about how long a run was: they
    // are the same run, and a reader will compare them.
    const started = events.filter((event) => event.type === 'agent.step.started');
    expect(trace.steps).toHaveLength(started.length);
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[0]?.toolCalls).toStrictEqual([]);
    expect(trace.steps[0]?.text).toBe('The sky is blue because of scattering.');
  });
});

describe('scenario 6 — a hallucinated citation', () => {
  it('marks a citation no tool returned as unverified and warns', async () => {
    const invented = 'https://plausible-but-invented.example.com/paper';
    const agentDeps = deps([
      turn.toolCall([{ id: 'c1', name: 'web_search', input: { query: 'why is the sky blue' } }]),
      finishCall('Scattering explains it. [1][2]', [SOURCE, invented]),
    ]);

    const { events, trace } = await run('why is the sky blue', agentDeps);

    expect(trace.status).toBe('succeeded');
    expect(trace.citations).toStrictEqual([
      { id: 1, url: SOURCE, title: 'Source 1', verified: true },
      { id: 2, url: invented, title: 'Source 2', verified: false },
    ]);

    const warning = trace.warnings.find((entry) => entry.kind === 'unverified_citation');
    expect(warning?.message).toContain(invented);

    const completed = events.at(-1);
    expect(completed?.type === 'run.completed' && completed.warnings).toHaveLength(1);
  });

  it('verifies a url that a tool returned in any shape, not just search results', async () => {
    const agentDeps = deps([
      turn.toolCall([{ id: 'c1', name: 'http_get', input: { url: SOURCE } }]),
      finishCall('Read it directly. [1]', [SOURCE]),
    ]);

    const { trace } = await run('why is the sky blue', agentDeps);
    expect(trace.citations[0]?.verified).toBe(true);
  });
});

describe('failures outside the model', () => {
  it('ends the run when the model call itself fails', async () => {
    const llm = {
      modelId: 'fake-model',
      complete: () => Promise.reject(new LlmError('provider is down')),
    };
    const agentDeps = { ...deps([]), llm };

    const { trace } = await run('anything', agentDeps);

    expect(trace.status).toBe('failed');
    expect(trace.outcome).toBe('llm_error');
    expect(trace.failureMessage).toContain('provider is down');
  });

  it('refuses more tool calls in one step than the policy allows', async () => {
    const agentDeps = deps(
      [
        turn.toolCall([
          { id: 'c1', name: 'calculator', input: { expression: '1+1' } },
          { id: 'c2', name: 'calculator', input: { expression: '2+2' } },
          { id: 'c3', name: 'calculator', input: { expression: '3+3' } },
        ]),
        finishCall('Done.', []),
      ],
      { policy: { maxToolCallsPerStep: 2 } },
    );

    const { events, trace } = await run('do sums', agentDeps);

    expect(events.filter((event) => event.type === 'tool.called' && event.step === 0)).toHaveLength(
      2,
    );
    expect(trace.steps[0]?.toolCalls).toHaveLength(2);
  });
});

describe('the trace as an artifact', () => {
  it('records enough to reconstruct the run without the events', async () => {
    const agentDeps = deps([
      turn.toolCall([{ id: 'c1', name: 'web_search', input: { query: 'why is the sky blue' } }], {
        text: 'Searching.',
        usage: { inputTokens: 1_000, outputTokens: 40 },
      }),
      finishCall('Answered. [1]', [SOURCE]),
    ]);

    const { trace } = await run('why is the sky blue', agentDeps);

    expect(trace.query).toBe('why is the sky blue');
    expect(trace.modelId).toBe('fake-model');
    expect(trace.budgets.maxSteps).toBe(DEFAULT_POLICY.maxSteps);
    expect(trace.usage.inputTokens).toBe(1_100);
    expect(trace.steps[0]?.text).toBe('Searching.');
    expect(trace.steps[0]?.toolCalls[0]?.tool).toBe('web_search');
    expect(trace.steps[0]?.toolCalls[0]?.outcome.status).toBe('ok');
    expect(trace.startedAt).toBe('2026-08-05T10:00:00.000Z');
  });

  it('redacts anything secret-looking in the arguments it records', async () => {
    const agentDeps = deps([
      turn.toolCall([
        { id: 'c1', name: 'http_get', input: { url: 'https://user:hunter2@example.com/x' } },
      ]),
      finishCall('Done.', []),
    ]);

    const { events, trace } = await run('anything', agentDeps);

    expect(JSON.stringify(trace)).not.toContain('hunter2');
    expect(JSON.stringify(events)).not.toContain('hunter2');
  });
});
