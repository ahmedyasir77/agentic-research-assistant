import { describe, expect, it } from 'vitest';

import { BUDGETS, makeEvent, resetSeq, scriptedRun, USAGE } from '../test/events.ts';
import { initialRunState, isRunning, runReducer, type RunState } from './runReducer.ts';

function fold(state: RunState, ...events: readonly Parameters<typeof makeEvent>[0][]): RunState {
  return events.reduce(
    (current, body) => runReducer(current, { type: 'event', event: makeEvent(body) }),
    state,
  );
}

function started(): RunState {
  resetSeq();
  return fold(runReducer(initialRunState, { type: 'submit', query: 'q', atMs: 1_000 }), {
    type: 'run.started',
    query: 'Why is the sky blue?',
    budgets: BUDGETS,
    modelId: 'fake-model',
  });
}

describe('runReducer', () => {
  it('starts empty and knows it is idle', () => {
    expect(initialRunState.phase).toBe('idle');
    expect(isRunning(initialRunState)).toBe(false);
  });

  it('records the submitted query and the clock it was given', () => {
    const state = runReducer(initialRunState, { type: 'submit', query: 'why', atMs: 42 });

    expect(state).toMatchObject({ phase: 'starting', query: 'why', startedAtMs: 42 });
    expect(isRunning(state)).toBe(true);
  });

  it('folds a whole run into an answer with citations', () => {
    const state = scriptedRun().reduce(
      (current, event) => runReducer(current, { type: 'event', event }),
      initialRunState,
    );

    expect(state.phase).toBe('completed');
    expect(state.answer).toBe('Rayleigh scattering. [1]');
    expect(state.citations).toHaveLength(1);
    expect(state.usage).toStrictEqual(USAGE);
    expect(state.durationMs).toBe(1234);
    expect(isRunning(state)).toBe(false);
  });

  it('attaches a tool call to its step and then resolves it', () => {
    const state = fold(
      started(),
      { type: 'agent.step.started', step: 0 },
      { type: 'agent.message', step: 0, text: 'Searching.' },
      { type: 'tool.called', step: 0, callId: 'c1', tool: 'web_search', args: { query: 'x' } },
      {
        type: 'tool.succeeded',
        step: 0,
        callId: 'c1',
        tool: 'web_search',
        durationMs: 12,
        output: { results: [] },
      },
    );

    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]?.text).toBe('Searching.');
    expect(state.steps[0]?.toolCalls[0]).toMatchObject({
      tool: 'web_search',
      status: 'ok',
      durationMs: 12,
    });
  });

  it('marks a failed tool call without ending the run', () => {
    const state = fold(
      started(),
      { type: 'agent.step.started', step: 0 },
      {
        type: 'tool.called',
        step: 0,
        callId: 'c1',
        tool: 'calculator',
        args: { expression: '1+' },
      },
      {
        type: 'tool.failed',
        step: 0,
        callId: 'c1',
        tool: 'calculator',
        durationMs: 3,
        error: { kind: 'invalid_arguments', message: 'Unexpected end of expression.' },
      },
    );

    expect(state.steps[0]?.toolCalls[0]).toMatchObject({
      status: 'error',
      errorMessage: 'Unexpected end of expression.',
    });
    expect(state.phase).toBe('running');
  });

  it('appends answer deltas so a streaming answer accumulates', () => {
    const state = fold(
      started(),
      { type: 'answer.delta', text: 'The sky ' },
      { type: 'answer.delta', text: 'is blue.' },
    );

    expect(state.answer).toBe('The sky is blue.');
  });

  it('keeps a budget-exceeded run’s partial answer', () => {
    const state = fold(started(), {
      type: 'run.failed',
      steps: 8,
      durationMs: 60_000,
      usage: USAGE,
      estimatedCostUsd: 0.02,
      reason: 'budget_exceeded',
      message: 'Stopped after 8 steps, the configured limit.',
      partialAnswer: 'What I had so far.',
      warnings: [],
    });

    expect(state.phase).toBe('failed');
    expect(state.failure).toStrictEqual({
      reason: 'budget_exceeded',
      message: 'Stopped after 8 steps, the configured limit.',
      partialAnswer: 'What I had so far.',
    });
    // A failed run still reports what it spent — that is the interesting part.
    expect(state.usage).toStrictEqual(USAGE);
  });

  it('ignores an event it has already folded in', () => {
    // EventSource reconnects on its own and the server replays from the last id it
    // was given, so a repeat is routine rather than a bug.
    const state = started();
    const replayed = runReducer(state, {
      type: 'event',
      event: makeEvent({
        type: 'run.started',
        query: 'q',
        budgets: BUDGETS,
        modelId: 'fake-model',
      }),
    });
    resetSeq();
    const duplicate = runReducer(replayed, {
      type: 'event',
      event: makeEvent({
        type: 'run.started',
        query: 'q',
        budgets: BUDGETS,
        modelId: 'fake-model',
      }),
    });

    expect(duplicate).toBe(replayed);
  });

  it('creates a step it never saw start, rather than dropping its tool calls', () => {
    // A stream resumed mid-run can begin inside a step.
    const state = fold(started(), {
      type: 'tool.called',
      step: 3,
      callId: 'c9',
      tool: 'http_get',
      args: { url: 'https://example.com' },
    });

    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]?.index).toBe(3);
    expect(state.steps[0]?.toolCalls).toHaveLength(1);
  });

  it('surfaces a client-side failure as a failed run', () => {
    const state = runReducer(started(), {
      type: 'client-error',
      message: 'The connection dropped.',
    });

    expect(state.phase).toBe('failed');
    expect(state.clientError).toBe('The connection dropped.');
  });

  it('goes back to empty on reset', () => {
    expect(runReducer(started(), { type: 'reset' })).toStrictEqual(initialRunState);
  });
});
