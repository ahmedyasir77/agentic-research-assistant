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

// Snippets long enough to clear the grounding check's minimum quote length, so a
// scripted run can quote one and exercise the snippet verdict rather than tripping
// the too-short rule on the way there.
const SNIPPET = 'Blue light scatters more strongly than red light does.';

const searchProvider: SearchProvider = {
  name: 'test',
  search: () =>
    Promise.resolve([
      { title: 'Optics', url: SOURCE, snippet: SNIPPET },
      {
        title: 'Scattering',
        url: OTHER_SOURCE,
        snippet: 'Intensity goes as the inverse fourth power.',
      },
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
  overrides: {
    policy?: Partial<AgentPolicy>;
    clock?: Clock;
    llm?: FakeLlmClient;
    http?: HttpClient;
  } = {},
): AgentDeps {
  return {
    runId: 'run_test',
    llm: overrides.llm ?? createFakeLlmClient(turns),
    tools: createToolRegistry({
      searchProvider,
      http: {
        http: overrides.http ?? http,
        resolveDns: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      },
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

/** The sentence the fake page actually contains, for citations meant to hold up. */
const PAGE_SENTENCE = 'Blue light scatters about 5.5 times more than red.';

type Source = string | { readonly url: string; readonly quote: string };

const finishCall = (answer: string, sources: readonly Source[]) =>
  turn.toolCall([
    {
      id: 'call_finish',
      name: 'finish',
      input: {
        answer,
        citations: sources.map((source, index) => ({
          id: index + 1,
          ...(typeof source === 'string' ? { url: source } : source),
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
      finishCall('Blue light scatters more. [1]', [{ url: SOURCE, quote: PAGE_SENTENCE }]),
    ]);

    const { events, trace } = await run('why is the sky blue', agentDeps);

    expect(trace.status).toBe('succeeded');
    expect(trace.outcome).toBe('completed');
    expect(trace.answer).toBe('Blue light scatters more. [1]');
    // Grounded at both rungs: a tool returned the URL, and the quote is in the text
    // that tool returned for it.
    expect(trace.citations).toStrictEqual([
      {
        id: 1,
        url: SOURCE,
        title: 'Source 1',
        quote: PAGE_SENTENCE,
        grounding: 'quoted',
        quoteMatch: { before: '', match: PAGE_SENTENCE, after: '' },
      },
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
    const agentDeps = deps(
      [
        turn.text('The sky is blue because of scattering.'),
        turn.text('I already told you: scattering.'),
      ],
      { policy: { maxNudges: 1 } },
    );

    const { events, trace } = await run('why is the sky blue', agentDeps);

    expect(trace.status).toBe('failed');
    expect(trace.outcome).toBe('no_tool_call');
    expect(trace.answer).toBe('I already told you: scattering.');
    expect(trace.warnings.map((warning) => warning.kind)).toContain('missing_finish_call');

    // Two model calls, two messages, one failure — no third attempt.
    expect(events.filter((event) => event.type === 'agent.message')).toHaveLength(2);
  });

  it('accepts a finish call made after the nudge', async () => {
    // No citations: this run called no tools, so any URL it cited would be one
    // nothing returned, and the citation correction — not the prose nudge under
    // test — would be what shaped the run.
    const agentDeps = deps([
      turn.text('The sky is blue because of scattering.'),
      finishCall('The sky is blue because of scattering.', []),
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
      finishCall('The sky is blue because of scattering.', []),
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

describe('scenario 6 — citations that do not hold up', () => {
  const invented = 'https://plausible-but-invented.example.com/paper';
  const search = turn.toolCall([
    { id: 'c1', name: 'web_search', input: { query: 'why is the sky blue' } },
  ]);
  const inventedFinish = finishCall('Scattering explains it. [1][2]', [SOURCE, invented]);

  it('hands an invented source back to the agent instead of shipping it', async () => {
    const agentDeps = deps([
      search,
      inventedFinish,
      finishCall('Scattering explains it. [1]', [SOURCE]),
    ]);

    const { trace } = await run('why is the sky blue', agentDeps);

    // The fabricated source never reaches the user at all: the loop caught it while
    // the agent still had steps, and the agent dropped it. This is the failure the
    // check exists for, so it is the one least worth shipping with a label on it.
    expect(trace.status).toBe('succeeded');
    expect(trace.citations).toStrictEqual([
      // Real source, no quote: the URL was checked and the claim was not.
      { id: 1, url: SOURCE, title: 'Source 1', grounding: 'url_only' },
    ]);
    expect(trace.warnings).toStrictEqual([]);
  });

  it('names the invented url in the correction it sends back', async () => {
    const llm = createFakeLlmClient([
      search,
      inventedFinish,
      finishCall('Scattering explains it. [1]', [SOURCE]),
    ]);

    await run('why is the sky blue', deps([], { llm }));

    // A correction that does not say which URL failed is a correction the agent has
    // to guess at, and it has only one turn to spend guessing.
    const correction = JSON.stringify(llm.requests.at(-1)?.messages);
    expect(correction).toContain(invented);
    expect(correction).toContain('No tool returned these URLs');
  });

  it('lets an invented source stand, labelled, rather than looping on it', async () => {
    // A model that will not take the correction still has to end the run, and the
    // label is what carries the failure once the nudge has been spent.
    const agentDeps = deps([search, inventedFinish, inventedFinish], {
      policy: { maxNudges: 1 },
    });

    const { events, trace } = await run('why is the sky blue', agentDeps);

    expect(trace.status).toBe('succeeded');
    expect(trace.citations).toStrictEqual([
      { id: 1, url: SOURCE, title: 'Source 1', grounding: 'url_only' },
      { id: 2, url: invented, title: 'Source 2', grounding: 'unobserved' },
    ]);

    const warning = trace.warnings.find((entry) => entry.kind === 'unverified_citation');
    expect(warning?.message).toContain(invented);

    const completed = events.at(-1);
    expect(completed?.type === 'run.completed' && completed.warnings).toHaveLength(1);
  });

  it('reports the same invented source cited twice as one warning', async () => {
    // The reported shape: one bad source behind two claims rendered the identical
    // sentence twice, which said there was a problem and doubled the noise about it.
    const twice = turn.toolCall([
      {
        id: 'call_finish',
        name: 'finish',
        input: {
          answer: 'Both claims. [2][2]',
          citations: [
            { id: 2, url: invented, title: 'Source 2' },
            { id: 2, url: invented, title: 'Source 2' },
          ],
        },
      },
    ]);
    const agentDeps = deps([search, twice, twice], { policy: { maxNudges: 1 } });

    const { trace } = await run('why is the sky blue', agentDeps);

    // Both citations are kept and labelled; only the repeated warning is collapsed.
    expect(trace.citations).toHaveLength(2);
    expect(trace.warnings.filter((entry) => entry.kind === 'unverified_citation')).toHaveLength(1);
  });

  it('does not let a page that refused to load count as a source that was read', async () => {
    // A bot challenge is real HTML served from the real URL. If the fetch counted as
    // a read, its text would become evidence for SOURCE, the url check would pass,
    // and a citation quoting the article from memory would be reported as a source
    // that "does not contain" the quote — blaming the page for the run's own failure
    // to read it. The honest verdict is that nothing was ever read here.
    const blocked: HttpClient = {
      get: () =>
        Promise.resolve({
          status: 429,
          headers: { 'content-type': 'text/html' },
          body: Readable.from(['<p>Security Checkpoint: verifying your browser</p>']),
        }),
    };
    const agentDeps = deps(
      [
        turn.toolCall([{ id: 'c1', name: 'http_get', input: { url: SOURCE } }]),
        finishCall('Scattering explains it. [1]', [{ url: SOURCE, quote: PAGE_SENTENCE }]),
      ],
      { http: blocked },
    );

    const { events, trace } = await run('why is the sky blue', agentDeps);

    const failure = events.find((event) => event.type === 'tool.failed');
    expect(failure?.type === 'tool.failed' && failure.error.message).toMatch(
      /refusing automated readers.*Do not cite this page/su,
    );

    expect(trace.citations[0]?.grounding).toBe('unobserved');
    expect(trace.warnings.map((entry) => entry.kind)).toContain('unverified_citation');
    expect(trace.warnings.map((entry) => entry.kind)).not.toContain('unsupported_quote');
  });

  // The one a URL check cannot see. The agent fetched this page and is citing it
  // honestly; the sentence it puts in the page's mouth is the fabrication.
  const misquote = 'Blue light scatters about 5.9 times more than red.';
  const read = turn.toolCall([{ id: 'c1', name: 'http_get', input: { url: SOURCE } }]);
  const misquoteFinish = finishCall('The ratio is 5.9. [1]', [{ url: SOURCE, quote: misquote }]);

  it('hands a misquote back to the agent instead of shipping it', async () => {
    const agentDeps = deps([
      read,
      misquoteFinish,
      finishCall('The ratio is 5.5. [1]', [{ url: SOURCE, quote: PAGE_SENTENCE }]),
    ]);

    const { trace } = await run('why is the sky blue', agentDeps);

    // The run corrected itself before finishing, so nothing unsupported reaches the
    // user at all — the failure never becomes a warning about a finished answer.
    expect(trace.status).toBe('succeeded');
    expect(trace.citations[0]?.grounding).toBe('quoted');
    expect(trace.warnings).toStrictEqual([]);
  });

  it('reports a fabricated source and a misquote in the same correction', async () => {
    const llm = createFakeLlmClient([
      read,
      finishCall('Both wrong. [1][2]', [{ url: SOURCE, quote: misquote }, invented]),
      finishCall('The ratio is 5.5. [1]', [{ url: SOURCE, quote: PAGE_SENTENCE }]),
    ]);

    const { trace } = await run('why is the sky blue', deps([], { llm }));

    // One nudge, both failures. The agent has to reissue the whole finish payload
    // either way, so correcting one and shipping the other fixes half the answer at
    // full price — and the nudge budget has nothing left to fix the rest with.
    const correction = JSON.stringify(llm.requests.at(-1)?.messages);
    expect(correction).toContain(invented);
    expect(correction).toContain('are not in it, character for character');

    expect(trace.status).toBe('succeeded');
    expect(trace.warnings).toStrictEqual([]);
  });

  it('distinguishes several failed quotes from one source', async () => {
    // The reported shape: the same source cited for several claims is several
    // citations sharing an id and a url, so a warning built from those two alone
    // renders every failure as the identical sentence.
    const repeated = turn.toolCall([
      {
        id: 'call_finish',
        name: 'finish',
        input: {
          answer: 'Both claims. [1][1]',
          citations: [
            { id: 1, url: SOURCE, title: 'Source 1', quote: misquote },
            { id: 1, url: SOURCE, title: 'Source 1', quote: 'Red light scatters twice as far.' },
          ],
        },
      },
    ]);
    const agentDeps = deps([read, repeated, repeated], { policy: { maxNudges: 1 } });

    const { trace } = await run('why is the sky blue', agentDeps);

    const messages = trace.warnings
      .filter((entry) => entry.kind === 'unsupported_quote')
      .map((entry) => entry.message);

    expect(messages).toHaveLength(2);
    expect(new Set(messages).size).toBe(2);
    expect(messages[0]).toContain('5.9 times more than red');
    expect(messages[1]).toContain('Red light scatters twice as far');
  });

  it('lets a misquote stand, labelled, rather than looping on it', async () => {
    // A model that will not take the correction still has to end the run, and the
    // label is what carries the failure once the nudge has been spent.
    const agentDeps = deps([read, misquoteFinish, misquoteFinish], { policy: { maxNudges: 1 } });

    const { trace } = await run('why is the sky blue', agentDeps);

    expect(trace.status).toBe('succeeded');
    expect(trace.citations[0]?.grounding).toBe('unsupported');
    expect(trace.citations[0]?.quoteMatch).toBeUndefined();

    const warning = trace.warnings.find((entry) => entry.kind === 'unsupported_quote');
    expect(warning?.message).toContain(SOURCE);
    // The quote itself, so several failures from one source are distinguishable.
    expect(warning?.message).toContain('5.9 times more than red');
  });

  // The correction is an improvement on an answer that already passed, so it is
  // worth a step and not worth the run. Each of these ends the correction turn a
  // different way; all three have to arrive at the same place.
  describe('when the correction turn never lands', () => {
    it('ships the held answer instead of losing the run to a provider failure', async () => {
      // Exactly the recorded grounding demo: four scripted turns ending in finish,
      // a misquote that sends the agent back, and no fifth turn to go back to.
      let calls = 0;
      const scripted = createFakeLlmClient([read, misquoteFinish]);
      const llm = {
        modelId: 'fake-model',
        complete: (request: Parameters<FakeLlmClient['complete']>[0]) => {
          calls += 1;
          return calls > 2
            ? Promise.reject(new LlmError('Fake LLM script exhausted after 2 turns.'))
            : scripted.complete(request);
        },
      };

      const { trace } = await run('why is the sky blue', { ...deps([]), llm });

      expect(trace.status).toBe('succeeded');
      expect(trace.answer).toBe('The ratio is 5.9. [1]');
      // The verdict the demo exists to show survives the fallback.
      expect(trace.citations[0]?.grounding).toBe('unsupported');
      expect(trace.warnings.map((entry) => entry.kind)).toStrictEqual([
        'uncorrected_citation',
        'unsupported_quote',
      ]);
      expect(trace.warnings[0]?.message).toContain('script exhausted');
    });

    it('ships the held answer when the correction turn runs out of steps', async () => {
      const agentDeps = deps([read, misquoteFinish], { policy: { maxSteps: 3 } });

      const { trace } = await run('why is the sky blue', agentDeps);

      expect(trace.status).toBe('succeeded');
      expect(trace.outcome).toBe('completed');
      expect(trace.citations[0]?.grounding).toBe('unsupported');
      expect(trace.warnings.map((entry) => entry.kind)).toContain('uncorrected_citation');
    });

    it('does not claim the citations went unchecked when the model answers in prose', async () => {
      // The prose path raises `missing_finish_call`, whose message says the
      // citations were never checked. With an answer in hand that is false: they
      // were checked, and the labels are on them.
      const agentDeps = deps([read, misquoteFinish, turn.text('The ratio is about 5.9.')], {
        policy: { maxNudges: 1 },
      });

      const { trace } = await run('why is the sky blue', agentDeps);

      expect(trace.status).toBe('succeeded');
      expect(trace.citations[0]?.grounding).toBe('unsupported');
      const kinds = trace.warnings.map((entry) => entry.kind);
      expect(kinds).toContain('uncorrected_citation');
      expect(kinds).not.toContain('missing_finish_call');
    });

    it('prefers the corrected answer when the agent does come back with one', async () => {
      // The fallback must not shadow the path it is a fallback for.
      const agentDeps = deps([
        read,
        misquoteFinish,
        finishCall('The ratio is 5.5. [1]', [{ url: SOURCE, quote: PAGE_SENTENCE }]),
      ]);

      const { trace } = await run('why is the sky blue', agentDeps);

      expect(trace.answer).toBe('The ratio is 5.5. [1]');
      expect(trace.citations[0]?.grounding).toBe('quoted');
      expect(trace.warnings).toStrictEqual([]);
    });
  });

  it('grounds a quote against a url a tool returned in any shape, not just search results', async () => {
    const agentDeps = deps([
      turn.toolCall([{ id: 'c1', name: 'http_get', input: { url: SOURCE } }]),
      finishCall('Read it directly. [1]', [{ url: SOURCE, quote: PAGE_SENTENCE }]),
    ]);

    const { trace } = await run('why is the sky blue', agentDeps);
    expect(trace.citations[0]?.grounding).toBe('quoted');
  });
});

describe('scenario 7 — an answer built entirely from search snippets', () => {
  const search = turn.toolCall([
    { id: 'c1', name: 'web_search', input: { query: 'why is the sky blue' } },
  ]);
  const snippetFinish = finishCall('Blue scatters more. [1]', [{ url: SOURCE, quote: SNIPPET }]);

  it('sends the agent back to read the source instead of accepting the answer', async () => {
    const agentDeps = deps([
      search,
      snippetFinish,
      turn.toolCall([{ id: 'c2', name: 'http_get', input: { url: SOURCE } }]),
      finishCall('Blue scatters more. [1]', [{ url: SOURCE, quote: PAGE_SENTENCE }]),
    ]);

    const { trace } = await run('why is the sky blue', agentDeps);

    // The finish that quoted a snippet did not end the run; the one that quoted the
    // page did, and its citation is grounded against the page rather than the
    // search engine's description of it.
    expect(trace.status).toBe('succeeded');
    expect(trace.citations[0]?.grounding).toBe('quoted');
    expect(trace.steps.flatMap((step) => step.toolCalls).map((call) => call.tool)).toStrictEqual([
      'web_search',
      'finish',
      'http_get',
      'finish',
    ]);
  });

  it('corrects once and then lets the answer stand, rather than looping', async () => {
    // A model that will not take the correction still has to end the run. The
    // labels carry what the nudge could not.
    const agentDeps = deps([search, snippetFinish, snippetFinish], { policy: { maxNudges: 1 } });

    const { trace } = await run('why is the sky blue', agentDeps);

    expect(trace.status).toBe('succeeded');
    expect(trace.citations[0]?.grounding).toBe('snippet');
    expect(trace.steps).toHaveLength(3);
  });

  it('accepts an answer that read even one of its sources', async () => {
    // The nudge asks whether the agent reads what it cites, not whether every
    // citation cleared the top rung — one page fetched answers that.
    const agentDeps = deps([
      turn.toolCall([
        { id: 'c1', name: 'web_search', input: { query: 'why is the sky blue' } },
        { id: 'c2', name: 'http_get', input: { url: SOURCE } },
      ]),
      finishCall('Blue scatters more. [1][2]', [
        { url: SOURCE, quote: PAGE_SENTENCE },
        { url: OTHER_SOURCE, quote: 'Intensity goes as the inverse fourth power.' },
      ]),
    ]);

    const { trace } = await run('why is the sky blue', agentDeps);

    expect(trace.citations.map((entry) => entry.grounding)).toStrictEqual(['quoted', 'snippet']);
    expect(trace.steps).toHaveLength(2);
  });

  it('leaves an answer that needed no sources alone', async () => {
    const agentDeps = deps([finishCall('Seventeen times twenty-three is 391.', [])]);

    const { trace } = await run('what is 17 times 23', agentDeps);

    expect(trace.status).toBe('succeeded');
    expect(trace.citations).toStrictEqual([]);
    expect(trace.steps).toHaveLength(1);
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

  it('calls a model call cut off by the deadline a spent budget, not a provider failure', async () => {
    // An aborted request throws the SDK's own generic error, so the signal is the
    // only thing that knows the run ran out of clock rather than the provider going
    // away. Getting this wrong told a real user to try again in a moment when the
    // fix was a longer budget.
    const llm = {
      modelId: 'fake-model',
      complete: (request: { signal?: AbortSignal }) =>
        new Promise<LlmResponse>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new LlmError('Request was aborted.'));
          });
        }),
    };
    const agentDeps = { ...deps([], { policy: { maxWallClockMs: 20 } }), llm };

    const { trace } = await run('a question that outlasts the clock', agentDeps);

    expect(trace.status).toBe('failed');
    expect(trace.outcome).toBe('budget_exceeded');
    expect(trace.failureMessage).toMatch(/time limit/u);
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
