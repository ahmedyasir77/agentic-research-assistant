import {
  AgentEventSchema,
  AppConfigSchema,
  CreateRunResponseSchema,
  ListToolsResponseSchema,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
  RunTraceSchema,
  type AgentEvent,
  type AgentEventType,
} from '@ara/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../agent/policy.ts';
import { createAgentRuntime, type AgentRuntime } from '../composition.ts';
import { loadConfig } from '../config/env.ts';
import type { LlmClient } from '../llm/port.ts';
import { silentLogger } from '../platform/logger.ts';
import { RunStore } from '../runs/store.ts';
import { createApi } from './server.ts';

/**
 * The API, end to end, against the recorded offline runtime: a real Express app,
 * the real agent loop, the real tools and the real fixtures. The only thing that
 * is not real is the model, which is the point — the event sequence below is
 * asserted exactly, and it could not be if a model were choosing the steps.
 */
const DEMO_QUERY = 'Why is the sky blue?';

const config = loadConfig({
  DEMO_MODE: 'offline',
  SEARCH_PROVIDER: 'fixture',
  LOG_LEVEL: 'silent',
});
const offlineRuntime = createAgentRuntime({ config, logger: silentLogger });

/**
 * A runtime whose model will not answer until the test says so, which is how a run
 * is held in flight without depending on a timer. An earlier version used a delay
 * and flaked: a recorded run finishes in single-digit milliseconds, so "still
 * running" was a race the test lost about one time in five.
 */
function gatedRuntime(): { runtime: AgentRuntime; release: () => void } {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  return {
    release: () => {
      open();
    },
    runtime: {
      tools: offlineRuntime.tools,
      modelId: offlineRuntime.modelId,
      llmFor: async (query) => {
        const inner = await offlineRuntime.llmFor(query);
        const gated: LlmClient = {
          modelId: inner.modelId,
          complete: async (llmRequest) => {
            await gate;
            return inner.complete(llmRequest);
          },
        };
        return gated;
      },
    },
  };
}

function buildApi(
  overrides: { runtime?: AgentRuntime; rateLimitPerMin?: number; store?: RunStore } = {},
) {
  const store = overrides.store ?? new RunStore();
  const api = createApi({
    runtime: overrides.runtime ?? offlineRuntime,
    policy: DEFAULT_POLICY,
    store,
    logger: silentLogger,
    // High by default so the limiter does not fire on unrelated tests; the test
    // that cares about it sets its own.
    rateLimitPerMin: overrides.rateLimitPerMin ?? 100,
    demoMode: 'offline',
  });
  return { ...api, store };
}

/** Turns an SSE body back into the events that produced it. */
function parseSse(body: string): AgentEvent[] {
  return body
    .split('\n\n')
    .flatMap((frame) => frame.split('\n').filter((line) => line.startsWith('data: ')))
    .map((line) => AgentEventSchema.parse(JSON.parse(line.slice('data: '.length))));
}

/** Every response body goes through its own schema, so the tests hold the API to its contract. */
async function createRun(app: Parameters<typeof request>[0]) {
  const response = await request(app).post('/api/runs').send({ query: DEMO_QUERY }).expect(202);
  return CreateRunResponseSchema.parse(response.body);
}

async function startAndFinish(app: Parameters<typeof request>[0], store: RunStore) {
  const created = await createRun(app);
  await store.get(created.runId)?.whenFinished;
  return created;
}

describe('POST /api/runs then subscribe', () => {
  it('answers with a run id and where to watch it', async () => {
    const { app, store } = buildApi();
    const { runId, eventsUrl } = await startAndFinish(app, store);

    expect(runId).toMatch(/^run_/u);
    expect(eventsUrl).toBe(`/api/runs/${runId}/events`);
  });

  it('streams the full event sequence of a recorded run', async () => {
    const { app, store } = buildApi();
    const { runId } = await startAndFinish(app, store);

    const stream = await request(app).get(`/api/runs/${runId}/events`).expect(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(stream.text);
    const step = (index: number): AgentEventType[] => [
      'agent.step.started',
      'agent.message',
      'tool.called',
      'tool.succeeded',
      ...(index === 3 ? (['answer.delta', 'run.completed'] as AgentEventType[]) : []),
    ];

    expect(events.map((event) => event.type)).toStrictEqual([
      'run.started',
      ...step(0),
      ...step(1),
      ...step(2),
      ...step(3),
    ]);

    expect(events.map((event) => event.seq)).toStrictEqual(events.map((_, index) => index));
    expect(events.every((event) => event.runId === runId)).toBe(true);
  });

  it('ends the run with a cited answer that the citation check verified', async () => {
    const { app, store } = buildApi();
    const { runId } = await startAndFinish(app, store);

    const events = parseSse((await request(app).get(`/api/runs/${runId}/events`)).text);
    const completed = events.at(-1);

    expect(completed?.type).toBe('run.completed');
    if (completed?.type !== 'run.completed') return;
    expect(completed.answer).toContain('Rayleigh scattering');
    expect(completed.citations).toHaveLength(2);
    expect(completed.citations.every((citation) => citation.verified)).toBe(true);
    expect(completed.warnings).toStrictEqual([]);
  });

  it('replays only what a reconnecting client missed', async () => {
    const { app, store } = buildApi();
    const { runId } = await startAndFinish(app, store);

    const resumed = await request(app)
      .get(`/api/runs/${runId}/events`)
      .set('Last-Event-ID', '15')
      .expect(200);

    expect(parseSse(resumed.text).map((event) => event.seq)).toStrictEqual([16, 17, 18]);
  });

  it('delivers events to a client that subscribed while the run was still going', async () => {
    const { runtime, release } = gatedRuntime();
    const { app, store } = buildApi({ runtime });
    const { runId } = await createRun(app);

    // Subscribed while the model is still held at the gate, so every event this
    // client receives arrives live. Replay could not have produced them.
    expect(store.get(runId)?.status).toBe('running');
    const streaming = request(app).get(`/api/runs/${runId}/events`).expect(200);
    release();
    const stream = await streaming;

    expect(parseSse(stream.text).at(-1)?.type).toBe('run.completed');
  });
});

describe('GET /api/runs/:runId', () => {
  it('returns the whole trace once the run has finished', async () => {
    const { app, store } = buildApi();
    const { runId } = await startAndFinish(app, store);

    const response = await request(app).get(`/api/runs/${runId}`).expect(200);
    const trace = RunTraceSchema.parse(response.body);

    expect(trace.runId).toBe(runId);
    expect(trace.outcome).toBe('completed');
    expect(trace.steps).toHaveLength(4);
    expect(trace.steps.flatMap((step) => step.toolCalls).map((call) => call.tool)).toStrictEqual([
      'web_search',
      'http_get',
      'calculator',
      'finish',
    ]);
    expect(trace.citations.every((citation) => citation.verified)).toBe(true);
  });

  it('says the run is still going rather than returning half a trace', async () => {
    const { runtime, release } = gatedRuntime();
    const { app, store } = buildApi({ runtime });
    const { runId } = await createRun(app);

    const response = await request(app).get(`/api/runs/${runId}`).expect(409);
    const problem = ProblemDetailsSchema.parse(response.body);

    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(problem.detail).toContain('/events');

    release();
    await store.get(runId)?.whenFinished;
  });

  it('returns problem+json for a run this instance has never heard of', async () => {
    const { app } = buildApi();

    const response = await request(app).get('/api/runs/run_nope').expect(404);
    const problem = ProblemDetailsSchema.parse(response.body);

    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(problem.type).toBe('/problems/run-not-found');
    expect(problem.instance).toBe('/api/runs/run_nope');
  });

  it('returns problem+json when subscribing to a run that does not exist', async () => {
    const { app } = buildApi();

    const response = await request(app).get('/api/runs/run_nope/events').expect(404);

    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
  });
});

describe('ingress limits', () => {
  it('names the field that failed validation', async () => {
    const { app } = buildApi();

    const response = await request(app).post('/api/runs').send({ query: 'no' }).expect(400);
    const problem = ProblemDetailsSchema.parse(response.body);

    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(problem.errors?.[0]?.path).toBe('query');
  });

  it('rejects a query longer than the cap', async () => {
    const { app } = buildApi();

    await request(app)
      .post('/api/runs')
      .send({ query: 'a'.repeat(501) })
      .expect(400);
  });

  it('rejects a body larger than the cap before parsing it', async () => {
    const { app } = buildApi();

    const response = await request(app)
      .post('/api/runs')
      .send({ query: 'a'.repeat(100_000) })
      .expect(413);

    expect(ProblemDetailsSchema.parse(response.body).type).toBe('/problems/body-too-large');
  });

  it('rejects a body that is not JSON', async () => {
    const { app } = buildApi();

    const response = await request(app)
      .post('/api/runs')
      .set('content-type', 'application/json')
      .send('{"query": ')
      .expect(400);

    expect(ProblemDetailsSchema.parse(response.body).detail).toContain('not valid JSON');
  });

  it('limits how many runs one caller can start', async () => {
    const { app, store } = buildApi({ rateLimitPerMin: 1 });

    const first = await createRun(app);
    const response = await request(app).post('/api/runs').send({ query: DEMO_QUERY }).expect(429);

    expect(response.headers['retry-after']).toBeDefined();
    expect(ProblemDetailsSchema.parse(response.body).type).toBe('/problems/rate-limited');
    await store.get(first.runId)?.whenFinished;
  });

  it('sheds load rather than growing without bound', async () => {
    // The cap is only full while the first run is in flight, so the first run is
    // held at the gate rather than raced against.
    const { runtime, release } = gatedRuntime();
    const { app, store } = buildApi({ runtime, store: new RunStore({ maxRuns: 1 }) });

    const first = await createRun(app);
    const response = await request(app).post('/api/runs').send({ query: DEMO_QUERY }).expect(503);

    expect(ProblemDetailsSchema.parse(response.body).type).toBe('/problems/at-capacity');

    release();
    await store.get(first.runId)?.whenFinished;
  });
});

describe('GET /api/config', () => {
  it('tells the browser which mode it is talking to', async () => {
    const { app } = buildApi();

    const response = await request(app).get('/api/config').expect(200);

    expect(AppConfigSchema.parse(response.body)).toStrictEqual({
      demoMode: 'offline',
      modelId: 'fake-model',
      eventSchemaVersion: 1,
    });
  });
});

describe('GET /api/tools', () => {
  it('publishes the same specs the model is given', async () => {
    const { app } = buildApi();

    const response = await request(app).get('/api/tools').expect(200);
    const { tools } = ListToolsResponseSchema.parse(response.body);

    expect(tools.map((tool) => tool.name)).toStrictEqual([
      'web_search',
      'http_get',
      'calculator',
      'finish',
    ]);
    expect(JSON.stringify(tools[0]?.inputSchema)).toContain('properties');
  });
});

describe('operations endpoints', () => {
  it('reports liveness', async () => {
    const { app } = buildApi();
    await request(app).get('/healthz').expect(200, { status: 'ok' });
  });

  it('stops reporting ready the moment the instance starts draining', async () => {
    const { app, lifecycle } = buildApi();

    await request(app).get('/readyz').expect(200);
    lifecycle.beginDraining();

    // Liveness stays green while readiness fails: the process is fine, it just
    // must not be sent new work.
    await request(app).get('/readyz').expect(503);
    await request(app).get('/healthz').expect(200);
  });

  it('exposes the run and tool metrics after a run', async () => {
    const { app, store } = buildApi();
    await startAndFinish(app, store);

    const response = await request(app).get('/metrics').expect(200);

    expect(response.text).toContain('agent_runs_total{outcome="completed"}');
    expect(response.text).toContain('tool_calls_total{tool="web_search",outcome="ok"}');
    expect(response.text).toContain('llm_tokens_total{type="input"}');
    expect(response.text).toContain('agent_steps_per_run');
  });
});

describe('unknown routes', () => {
  it('answer in the same shape as every other error', async () => {
    const { app } = buildApi();

    const response = await request(app).get('/nope').expect(404);

    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(ProblemDetailsSchema.parse(response.body).title).toBe('No such endpoint.');
  });
});

describe('a run whose model client cannot be built', () => {
  it('fails the request rather than handing back a run that goes nowhere', async () => {
    const broken: AgentRuntime = {
      tools: offlineRuntime.tools,
      modelId: 'fake-model',
      llmFor: () => Promise.reject(new Error('no adapter')),
    };
    const { app, store } = buildApi({ runtime: broken });

    const response = await request(app).post('/api/runs').send({ query: DEMO_QUERY }).expect(500);

    expect(ProblemDetailsSchema.parse(response.body).status).toBe(500);
    expect(store.size).toBe(0);
  });
});
