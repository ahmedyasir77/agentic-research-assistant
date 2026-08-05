import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * One registry, exposed at /metrics. The metrics are chosen to answer the
 * questions an operator actually asks about an agent: are runs succeeding, how
 * many steps are they taking, which tool is slow, and what is it costing.
 */
export const metricsRegistry = new Registry();

export const toolCallsTotal = new Counter({
  name: 'tool_calls_total',
  help: 'Tool invocations by tool and outcome.',
  labelNames: ['tool', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const toolDurationSeconds = new Histogram({
  name: 'tool_duration_seconds',
  help: 'Wall-clock duration of a tool invocation.',
  labelNames: ['tool'] as const,
  // Bucketed for sub-second tools with a long tail up to the 5s http_get timeout.
  buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const agentRunsTotal = new Counter({
  name: 'agent_runs_total',
  help: 'Completed agent runs by outcome — one series per RunOutcome.',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

export const agentStepsPerRun = new Histogram({
  name: 'agent_steps_per_run',
  help: 'Reason-act steps a run took before it stopped.',
  // Bucketed around the default maxSteps of 8: the interesting question is how
  // close runs get to the ceiling, not how they distribute across a wide range.
  buckets: [1, 2, 3, 4, 5, 6, 8, 10, 20],
  registers: [metricsRegistry],
});

export const llmTokensTotal = new Counter({
  name: 'llm_tokens_total',
  help: 'Tokens billed, by direction.',
  labelNames: ['type'] as const,
  registers: [metricsRegistry],
});

export const llmRequestDurationSeconds = new Histogram({
  name: 'llm_request_duration_seconds',
  help: 'Wall-clock duration of one model call.',
  labelNames: ['model', 'outcome'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

/**
 * Process metrics are opt-in rather than collected on import, so importing this
 * module from a test does not start a collection interval that keeps Node alive.
 */
export function registerDefaultMetrics(): void {
  collectDefaultMetrics({ register: metricsRegistry });
}
