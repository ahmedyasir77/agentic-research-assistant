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

/**
 * Process metrics are opt-in rather than collected on import, so importing this
 * module from a test does not start a collection interval that keeps Node alive.
 */
export function registerDefaultMetrics(): void {
  collectDefaultMetrics({ register: metricsRegistry });
}
