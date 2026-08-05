import type { JsonValue } from '@ara/shared';
import { z } from 'zod';

import {
  LlmError,
  LlmResponseSchema,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from './port.ts';

/**
 * Replays a fixed list of model turns.
 *
 * This is the single most useful object in the repo for two reasons. It makes the
 * agent loop deterministic, so "the model returns malformed arguments and the agent
 * recovers" is an ordinary unit test instead of a hope. And it powers
 * `DEMO_MODE=offline`, so the whole app runs with no API key and no network.
 */
export const FAKE_MODEL_ID = 'fake-model';

export const LlmScriptSchema = z.object({
  /** Free text for whoever reads the fixture later — not used at runtime. */
  description: z.string().optional(),
  turns: z.array(LlmResponseSchema).min(1),
});
export type LlmScript = z.infer<typeof LlmScriptSchema>;

export interface FakeLlmClientOptions {
  /** Recorded for assertions: what the loop actually sent, turn by turn. */
  readonly onRequest?: (request: LlmRequest, turn: number) => void;
}

export interface FakeLlmClient extends LlmClient {
  /** Every request the loop made, in order — the loop's side of the conversation. */
  readonly requests: readonly LlmRequest[];
  readonly turnsRemaining: number;
}

export function createFakeLlmClient(
  turns: readonly LlmResponse[],
  options: FakeLlmClientOptions = {},
): FakeLlmClient {
  const queue = [...turns];
  const requests: LlmRequest[] = [];

  return {
    modelId: FAKE_MODEL_ID,
    get requests() {
      return requests;
    },
    get turnsRemaining() {
      return queue.length;
    },
    complete: (request) => {
      // A port that returns a promise must never throw synchronously — the caller
      // is entitled to handle every failure the same way.
      if (request.signal.aborted) {
        return Promise.reject(new LlmError('Request aborted before it was sent.'));
      }
      options.onRequest?.(request, requests.length);
      requests.push(request);

      const next = queue.shift();
      if (next === undefined) {
        // Running past the end of the script means the loop took a path the test
        // did not anticipate. Failing loudly beats silently ending the turn.
        return Promise.reject(
          new LlmError(
            `Fake LLM script exhausted after ${String(requests.length - 1)} turns. ` +
              'The agent asked for another turn than the script provides.',
          ),
        );
      }
      return Promise.resolve(next);
    },
  };
}

/** Builders that keep test scripts readable, so a scenario reads like its own name. */
export const turn = {
  text: (text: string, usage = defaultUsage()): LlmResponse => ({
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage,
    modelId: FAKE_MODEL_ID,
  }),

  toolCall: (
    calls: readonly { id: string; name: string; input: JsonValue }[],
    options: { text?: string; usage?: { inputTokens: number; outputTokens: number } } = {},
  ): LlmResponse => ({
    content: [
      ...(options.text === undefined ? [] : [{ type: 'text' as const, text: options.text }]),
      ...calls.map((call) => ({
        type: 'tool_use' as const,
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    ],
    stopReason: 'tool_use',
    usage: options.usage ?? defaultUsage(),
    modelId: FAKE_MODEL_ID,
  }),
};

function defaultUsage(): { inputTokens: number; outputTokens: number } {
  return { inputTokens: 100, outputTokens: 50 };
}
