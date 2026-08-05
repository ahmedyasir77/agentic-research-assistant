import { describe, expect, it } from 'vitest';

import { createFakeLlmClient, FAKE_MODEL_ID, turn } from './fake.ts';
import { assistantText, LlmError, toolUses, type LlmRequest } from './port.ts';

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    system: 'You are a research assistant.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'why is the sky blue' }] }],
    tools: [],
    maxOutputTokens: 4_096,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('FakeLlmClient', () => {
  it('replays its script one turn at a time', async () => {
    const client = createFakeLlmClient([
      turn.toolCall([{ id: 'c1', name: 'web_search', input: { query: 'sky' } }]),
      turn.text('The sky is blue.'),
    ]);

    const first = await client.complete(request());
    expect(toolUses(first)).toHaveLength(1);
    expect(toolUses(first)[0]?.name).toBe('web_search');

    const second = await client.complete(request());
    expect(assistantText(second)).toBe('The sky is blue.');
    expect(client.turnsRemaining).toBe(0);
  });

  it('records what the loop sent, so a test can assert on the conversation', async () => {
    const client = createFakeLlmClient([turn.text('done')]);
    await client.complete(request({ system: 'custom system prompt' }));

    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.system).toBe('custom system prompt');
  });

  it('fails loudly when the agent asks for more turns than the script has', async () => {
    // A silent end-of-turn here would make a broken loop look like a passing test.
    const client = createFakeLlmClient([turn.text('done')]);
    await client.complete(request());

    await expect(client.complete(request())).rejects.toThrow(LlmError);
    await expect(client.complete(request())).rejects.toThrow(/script exhausted/u);
  });

  it('respects an aborted signal, like a real client would', async () => {
    const client = createFakeLlmClient([turn.text('done')]);
    await expect(client.complete(request({ signal: AbortSignal.abort() }))).rejects.toThrow();
  });

  it('reports the fake model id, so the trace never claims a real model ran', () => {
    expect(createFakeLlmClient([turn.text('x')]).modelId).toBe(FAKE_MODEL_ID);
  });
});

describe('turn builders', () => {
  it('builds a tool call with optional leading text', () => {
    const response = turn.toolCall(
      [{ id: 'c1', name: 'calculator', input: { expression: '1+1' } }],
      {
        text: 'Let me check that.',
      },
    );

    expect(response.stopReason).toBe('tool_use');
    expect(assistantText(response)).toBe('Let me check that.');
    expect(toolUses(response)[0]?.input).toStrictEqual({ expression: '1+1' });
  });

  it('builds parallel tool calls in one turn', () => {
    const response = turn.toolCall([
      { id: 'c1', name: 'web_search', input: { query: 'a' } },
      { id: 'c2', name: 'web_search', input: { query: 'b' } },
    ]);

    expect(toolUses(response)).toHaveLength(2);
  });
});
