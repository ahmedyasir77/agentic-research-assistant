import type {
  AgentEvent,
  JsonValue,
  RunBudgets,
  RunFailureReason,
  RunWarning,
  TokenUsage,
  VerifiedCitation,
} from '@ara/shared';

/**
 * Every event the server sends folds into this one shape, and nothing else in the
 * UI holds run state. Keeping it a pure function of (state, action) is what makes
 * "budget exceeded on step 8 with a partial answer" a unit test rather than
 * something you have to reproduce in a browser.
 */
export type RunPhase = 'idle' | 'starting' | 'running' | 'completed' | 'failed';

export interface ToolCallView {
  readonly callId: string;
  readonly tool: string;
  readonly args: JsonValue;
  readonly status: 'running' | 'ok' | 'error';
  readonly durationMs?: number;
  readonly output?: JsonValue;
  readonly errorMessage?: string;
}

export interface StepView {
  readonly index: number;
  readonly text: string;
  readonly toolCalls: readonly ToolCallView[];
}

export interface RunFailureView {
  readonly reason: RunFailureReason;
  readonly message: string;
  readonly partialAnswer?: string;
}

export interface RunState {
  readonly phase: RunPhase;
  readonly query: string;
  readonly runId?: string;
  readonly modelId?: string;
  readonly budgets?: RunBudgets;
  readonly startedAtMs?: number;
  readonly steps: readonly StepView[];
  readonly answer: string;
  readonly citations: readonly VerifiedCitation[];
  readonly warnings: readonly RunWarning[];
  readonly usage: TokenUsage;
  readonly estimatedCostUsd: number;
  readonly durationMs?: number;
  readonly failure?: RunFailureView;
  /** Highest event sequence folded in, so a replayed event is ignored rather than doubled. */
  readonly lastSeq: number;
  /** Something went wrong on this side — a dropped stream, an unparseable event. */
  readonly clientError?: string;
}

export type RunAction =
  /** The clock arrives as data so the reducer stays pure and the elapsed counter is testable. */
  | { readonly type: 'submit'; readonly query: string; readonly atMs: number }
  | { readonly type: 'accepted'; readonly runId: string }
  | { readonly type: 'event'; readonly event: AgentEvent }
  | { readonly type: 'client-error'; readonly message: string }
  | { readonly type: 'reset' };

export const initialRunState: RunState = {
  phase: 'idle',
  query: '',
  steps: [],
  answer: '',
  citations: [],
  warnings: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  estimatedCostUsd: 0,
  lastSeq: -1,
};

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'submit':
      return {
        ...initialRunState,
        phase: 'starting',
        query: action.query,
        startedAtMs: action.atMs,
      };

    case 'accepted':
      return { ...state, runId: action.runId };

    case 'event':
      // `EventSource` reconnects on its own and the server replays from the last
      // id it was given, so an event arriving twice is normal, not an error.
      return action.event.seq <= state.lastSeq ? state : applyEvent(state, action.event);

    case 'client-error':
      return { ...state, phase: 'failed', clientError: action.message };

    case 'reset':
      return initialRunState;
  }
}

function applyEvent(state: RunState, event: AgentEvent): RunState {
  const next = { ...state, lastSeq: event.seq };

  switch (event.type) {
    case 'run.started':
      return {
        ...next,
        phase: 'running',
        runId: event.runId,
        query: event.query,
        budgets: event.budgets,
        modelId: event.modelId,
      };

    case 'agent.step.started':
      return { ...next, steps: [...next.steps, { index: event.step, text: '', toolCalls: [] }] };

    case 'agent.message':
      return {
        ...next,
        steps: updateStep(next.steps, event.step, (step) => ({ ...step, text: event.text })),
      };

    case 'tool.called':
      return {
        ...next,
        steps: updateStep(next.steps, event.step, (step) => ({
          ...step,
          toolCalls: [
            ...step.toolCalls,
            { callId: event.callId, tool: event.tool, args: event.args, status: 'running' },
          ],
        })),
      };

    case 'tool.succeeded':
      return {
        ...next,
        steps: updateCall(next.steps, event.step, event.callId, (call) => ({
          ...call,
          status: 'ok',
          durationMs: event.durationMs,
          output: event.output,
        })),
      };

    case 'tool.failed':
      return {
        ...next,
        steps: updateCall(next.steps, event.step, event.callId, (call) => ({
          ...call,
          status: 'error',
          durationMs: event.durationMs,
          errorMessage: event.error.message,
        })),
      };

    case 'answer.delta':
      return { ...next, answer: next.answer + event.text };

    case 'run.completed':
      return {
        ...next,
        phase: 'completed',
        answer: event.answer,
        citations: event.citations,
        warnings: event.warnings,
        usage: event.usage,
        estimatedCostUsd: event.estimatedCostUsd,
        durationMs: event.durationMs,
      };

    case 'run.failed':
      return {
        ...next,
        phase: 'failed',
        warnings: event.warnings,
        usage: event.usage,
        estimatedCostUsd: event.estimatedCostUsd,
        durationMs: event.durationMs,
        failure: {
          reason: event.reason,
          message: event.message,
          ...(event.partialAnswer === undefined ? {} : { partialAnswer: event.partialAnswer }),
        },
      };
  }
}

/**
 * A step the UI has not seen the start of is created on the spot. Events cannot
 * arrive out of order over one SSE connection, but a resumed stream can begin
 * mid-step, and dropping those tool calls would silently shorten the timeline.
 */
function updateStep(
  steps: readonly StepView[],
  index: number,
  change: (step: StepView) => StepView,
): readonly StepView[] {
  if (!steps.some((step) => step.index === index)) {
    return [...steps, change({ index, text: '', toolCalls: [] })];
  }
  return steps.map((step) => (step.index === index ? change(step) : step));
}

function updateCall(
  steps: readonly StepView[],
  index: number,
  callId: string,
  change: (call: ToolCallView) => ToolCallView,
): readonly StepView[] {
  return updateStep(steps, index, (step) => ({
    ...step,
    toolCalls: step.toolCalls.map((call) => (call.callId === callId ? change(call) : call)),
  }));
}

/** True while the agent is working — the one predicate the UI asks over and over. */
export function isRunning(state: RunState): boolean {
  return state.phase === 'starting' || state.phase === 'running';
}
