import {
  AgentEventSchema,
  EVENT_SCHEMA_VERSION,
  TRACE_SCHEMA_VERSION,
  type AgentEvent,
  type RunBudgets,
  type RunFailureReason,
  type RunStep,
  type RunTrace,
  type RunWarning,
  type TokenUsage,
  type VerifiedCitation,
} from '@ara/shared';

import { estimateCostUsd } from '../llm/pricing.ts';
import type { Clock } from './types.ts';

/** An event minus the envelope the recorder stamps on. */
type WithoutEnvelope<T> = T extends AgentEvent ? Omit<T, 'v' | 'seq' | 'runId' | 'ts'> : never;
export type AgentEventBody = WithoutEnvelope<AgentEvent>;

export interface RecorderInit {
  readonly runId: string;
  readonly query: string;
  readonly budgets: RunBudgets;
  readonly modelId: string;
  readonly clock: Clock;
  readonly emit?: (event: AgentEvent) => void;
}

/**
 * The bookkeeping half of a run: stamps events, accumulates the trace, and works
 * out what the run cost. Kept out of `loop.ts` so that file is nothing but the
 * decisions the agent makes.
 */
export class RunRecorder {
  readonly #init: RecorderInit;
  readonly #startedAtMs: number;
  readonly #steps: RunStep[] = [];
  readonly #warnings: RunWarning[] = [];
  #usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  #seq = 0;

  constructor(init: RecorderInit) {
    this.#init = init;
    this.#startedAtMs = init.clock.now();
  }

  get elapsedMs(): number {
    return this.#init.clock.now() - this.#startedAtMs;
  }

  get stepCount(): number {
    return this.#steps.length;
  }

  /**
   * Stamps the envelope and validates against the shared contract before the event
   * leaves the loop. Parsing our own output looks redundant until the day a field
   * is renamed in `packages/shared` and this fails immediately instead of the
   * browser silently dropping events.
   */
  event(body: AgentEventBody): AgentEvent {
    const event = AgentEventSchema.parse({
      ...body,
      v: EVENT_SCHEMA_VERSION,
      seq: this.#seq,
      runId: this.#init.runId,
      ts: new Date(this.#init.clock.now()).toISOString(),
    });
    this.#seq += 1;
    this.#init.emit?.(event);
    return event;
  }

  addUsage(usage: TokenUsage): void {
    this.#usage = {
      inputTokens: this.#usage.inputTokens + usage.inputTokens,
      outputTokens: this.#usage.outputTokens + usage.outputTokens,
    };
  }

  addWarning(warning: RunWarning): void {
    this.#warnings.push(warning);
  }

  addStep(step: RunStep): void {
    this.#steps.push(step);
  }

  get summary(): {
    steps: number;
    durationMs: number;
    usage: TokenUsage;
    estimatedCostUsd: number;
  } {
    return {
      steps: this.#steps.length,
      durationMs: this.elapsedMs,
      usage: this.#usage,
      estimatedCostUsd: estimateCostUsd(this.#init.modelId, this.#usage),
    };
  }

  get warnings(): readonly RunWarning[] {
    return this.#warnings;
  }

  succeeded(answer: string, citations: readonly VerifiedCitation[]): RunTrace {
    return this.#trace({
      status: 'succeeded',
      outcome: 'completed',
      answer,
      citations: [...citations],
    });
  }

  failed(reason: RunFailureReason, message: string, partialAnswer?: string): RunTrace {
    return this.#trace({
      status: 'failed',
      outcome: reason,
      failureMessage: message,
      // A failed run still hands back what it had. A budget-exceeded run with a
      // half-formed answer is more useful than an empty one.
      ...(partialAnswer === undefined || partialAnswer === '' ? {} : { answer: partialAnswer }),
      citations: [],
    });
  }

  #trace(
    end: Pick<RunTrace, 'status' | 'outcome' | 'citations'> &
      Partial<Pick<RunTrace, 'answer' | 'failureMessage'>>,
  ): RunTrace {
    const endedAtMs = this.#init.clock.now();
    return {
      v: TRACE_SCHEMA_VERSION,
      runId: this.#init.runId,
      query: this.#init.query,
      budgets: this.#init.budgets,
      modelId: this.#init.modelId,
      startedAt: new Date(this.#startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: endedAtMs - this.#startedAtMs,
      steps: [...this.#steps],
      warnings: [...this.#warnings],
      usage: this.#usage,
      estimatedCostUsd: estimateCostUsd(this.#init.modelId, this.#usage),
      ...end,
    };
  }
}
