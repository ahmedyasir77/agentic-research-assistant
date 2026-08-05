import type { AgentEvent, RunTrace } from '@ara/shared';

import type { LlmClient } from '../llm/port.ts';
import type { Logger } from '../platform/logger.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { AgentPolicy } from './policy.ts';

/** Injected so a run's timestamps and durations are fixed values in a test. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * Everything the loop needs, all of it injected. The loop performs no I/O of its
 * own, imports nothing from Express, and reads no configuration — which is what
 * makes every one of its failure modes an ordinary unit test.
 */
export interface AgentDeps {
  readonly runId: string;
  readonly llm: LlmClient;
  readonly tools: ToolRegistry;
  readonly policy: AgentPolicy;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * The run yields events as they happen and returns the finished trace. Callers
 * that only want to watch can `for await`; callers that need the receipts drive
 * it with `.next()` and keep the return value.
 */
export type AgentRun = AsyncGenerator<AgentEvent, RunTrace, void>;
