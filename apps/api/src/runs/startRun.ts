import {
  AgentEventSchema,
  EVENT_SCHEMA_VERSION,
  type AgentEvent,
  type RunTrace,
} from '@ara/shared';

import { runAgent } from '../agent/loop.ts';
import type { AgentPolicy } from '../agent/policy.ts';
import { systemClock } from '../agent/types.ts';
import type { AgentRuntime } from '../composition.ts';
import { withLlmMetrics } from '../llm/instrumented.ts';
import type { LlmClient } from '../llm/port.ts';
import type { Logger } from '../platform/logger.ts';
import { agentRunsTotal, agentStepsPerRun } from '../platform/metrics.ts';
import type { RunRecord, RunStore } from './store.ts';

export interface StartRunDeps {
  readonly store: RunStore;
  readonly runtime: AgentRuntime;
  readonly policy: AgentPolicy;
  readonly logger: Logger;
}

/**
 * Starts a run and hands back its record before it finishes.
 *
 * The model client is resolved first, on purpose: if it cannot be built — no
 * fixture, no adapter, no key — the caller gets an error from `POST /api/runs`
 * rather than a run id that leads to a stream of nothing.
 */
export async function startRun(query: string, deps: StartRunDeps): Promise<RunRecord> {
  const llm = withLlmMetrics(await deps.runtime.llmFor(query));
  const record = deps.store.create(query);

  // Deliberately not awaited — the request returns while the agent is still
  // working. `record.whenFinished` is how shutdown waits for it instead.
  void driveRun(record, llm, deps);
  return record;
}

async function driveRun(record: RunRecord, llm: LlmClient, deps: StartRunDeps): Promise<void> {
  const logger = deps.logger.child({ runId: record.runId });

  const run = runAgent(record.query, {
    runId: record.runId,
    llm,
    tools: deps.runtime.tools,
    policy: deps.policy,
    clock: systemClock,
    logger,
  });

  try {
    // Driven by hand rather than with `for await`, because the trace is the
    // generator's return value and a for-await loop throws it away.
    for (let next = await run.next(); ; next = await run.next()) {
      if (next.done) {
        finish(record, next.value, logger);
        return;
      }
      record.emitter.publish(next.value);
    }
  } catch (error) {
    // The loop contracts never to throw: every failure it knows about is a
    // `run.failed` event. Reaching here is our bug, so it is logged as one — and
    // the run is still ended, because a client is holding a stream open.
    logger.error({ err: error }, 'agent loop threw, which it is not supposed to do');
    record.emitter.publish(crashEvent(record));
    record.finish();
    agentRunsTotal.inc({ outcome: 'internal_error' });
  }
}

function finish(record: RunRecord, trace: RunTrace, logger: Logger): void {
  record.finish(trace);

  const outcome = trace.outcome ?? 'internal_error';
  agentRunsTotal.inc({ outcome });
  agentStepsPerRun.observe(trace.steps.length);

  // The one line per run that answers "what happened and what did it cost",
  // without anyone having to read the trace.
  logger.info(
    {
      outcome,
      steps: trace.steps.length,
      durationMs: trace.durationMs,
      toolCalls: trace.steps.reduce((total, step) => total + step.toolCalls.length, 0),
      usage: trace.usage,
      estimatedCostUsd: trace.estimatedCostUsd,
      warnings: trace.warnings.length,
    },
    'run finished',
  );
}

/** The last thing a crashed run says, so the stream ends with an explanation. */
function crashEvent(record: RunRecord): AgentEvent {
  return AgentEventSchema.parse({
    v: EVENT_SCHEMA_VERSION,
    seq: record.emitter.events.length,
    runId: record.runId,
    ts: new Date().toISOString(),
    type: 'run.failed',
    reason: 'internal_error',
    message: 'The run stopped unexpectedly. This is a bug on our side, not a bad question.',
    steps: 0,
    durationMs: Date.now() - record.createdAtMs,
    usage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
    warnings: [],
  });
}
