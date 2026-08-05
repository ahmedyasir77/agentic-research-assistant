import type { AgentEvent, ToolCallRecord } from '@ara/shared';

import type { ContentBlock, ToolUseBlock } from '../llm/port.ts';
import { redactArgs } from '../platform/redact.ts';
import { FINISH_TOOL_NAME } from '../tools/finish.ts';
import type { ToolInvocation } from '../tools/registry.ts';
import { collectUrls } from './citations.ts';
import type { AgentPolicy } from './policy.ts';
import type { RunRecorder } from './recorder.ts';
import type { AgentDeps } from './types.ts';

export interface ToolStepResult {
  /** The `tool_result` blocks to send back — one per requested call, always. */
  readonly results: ContentBlock[];
  readonly records: ToolCallRecord[];
  /** Set when the model called `finish` and the payload validated. */
  readonly finished?: ToolInvocation;
}

export interface ToolStepInput {
  readonly step: number;
  readonly calls: readonly ToolUseBlock[];
  readonly policy: AgentPolicy;
  readonly deps: AgentDeps;
  readonly recorder: RunRecorder;
  readonly signal: AbortSignal;
  readonly observedUrls: Set<string>;
}

/**
 * Runs one step's tool calls and turns each outcome into the three things the loop
 * needs: an event for the timeline, a record for the trace, and a `tool_result`
 * for the model.
 *
 * Calls the model requested together are executed together — they are independent
 * by construction, so making them wait on each other only spends wall clock.
 */
export async function* executeToolCalls(
  input: ToolStepInput,
): AsyncGenerator<AgentEvent, ToolStepResult, void> {
  const { step, calls, policy, deps, recorder, signal, observedUrls } = input;

  // Anything beyond the per-step cap is refused rather than silently dropped:
  // every tool_use must come back with a tool_result, and the model is told why.
  const accepted = calls.slice(0, policy.maxToolCallsPerStep);
  const refused = calls.slice(policy.maxToolCallsPerStep);

  for (const call of accepted) {
    yield recorder.event({
      type: 'tool.called',
      step,
      callId: call.id,
      tool: call.name,
      args: redactArgs(call.input),
    });
  }

  const invocations = await Promise.all(
    accepted.map((call) =>
      deps.tools.invoke(call.name, call.input, {
        runId: deps.runId,
        step,
        signal,
        logger: deps.logger,
      }),
    ),
  );

  const results: ContentBlock[] = [];
  const records: ToolCallRecord[] = [];

  for (const [index, call] of accepted.entries()) {
    const invocation = invocations[index];
    if (invocation === undefined) continue;
    const { outcome, durationMs } = invocation;

    records.push({
      callId: call.id,
      tool: call.name,
      args: redactArgs(call.input),
      outcome,
      durationMs,
    });

    if (outcome.status === 'ok') {
      // Deliberately not `finish`. Its output echoes its input, so collecting from
      // it would add the model's own claimed citations to the evidence set and the
      // check would verify the answer against itself — passing every time, catching
      // nothing. Only tools that actually went and got something count as evidence.
      if (call.name !== FINISH_TOOL_NAME) collectUrls(outcome.output, observedUrls);
      yield recorder.event({
        type: 'tool.succeeded',
        step,
        callId: call.id,
        tool: call.name,
        durationMs,
        output: outcome.output,
      });
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: JSON.stringify(outcome.output),
        isError: false,
      });
      continue;
    }

    if (outcome.error.kind === 'invalid_arguments') {
      recorder.addWarning({ kind: 'invalid_tool_arguments', message: outcome.error.message });
    }
    yield recorder.event({
      type: 'tool.failed',
      step,
      callId: call.id,
      tool: call.name,
      durationMs,
      error: outcome.error,
    });
    // The error text is what the model reads next turn, which is why tools write
    // their failures as advice rather than as diagnostics.
    results.push({
      type: 'tool_result',
      toolUseId: call.id,
      content: outcome.error.message,
      isError: true,
    });
  }

  for (const call of refused) {
    results.push({
      type: 'tool_result',
      toolUseId: call.id,
      content: `Not run: at most ${String(policy.maxToolCallsPerStep)} tool calls per step. Ask again on the next step.`,
      isError: true,
    });
  }

  const finished = findFinish(accepted, invocations);
  return { results, records, ...(finished === undefined ? {} : { finished }) };
}

/** The `finish` call, if the model made one and its payload validated. */
function findFinish(
  calls: readonly ToolUseBlock[],
  invocations: readonly ToolInvocation[],
): ToolInvocation | undefined {
  const index = calls.findIndex((call) => call.name === FINISH_TOOL_NAME);
  if (index === -1) return undefined;
  const invocation = invocations[index];
  // A `finish` whose arguments failed validation is not a finish: the model gets
  // the error back and tries again, which is the recovery path the tests cover.
  return invocation?.outcome.status === 'ok' ? invocation : undefined;
}
