import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { secret } from '../config/secret.ts';
import { createAxiosJsonPoster } from '../platform/jsonPost.ts';
import { isTransient } from '../platform/transient.ts';
import { createAnthropicClient } from './anthropic.ts';
import { LlmError, type LlmRequest, type LlmResponse } from './port.ts';

/**
 * The adapter against a stubbed Messages API. `msw` rather than a fake poster on
 * purpose: this is the one seam where a mapping mistake is invisible in types and
 * only shows up on the wire, so the test asserts the bytes.
 */
const MESSAGES_URL = 'https://api.anthropic.test/v1/messages';

let lastBody: unknown;
let lastHeaders: Headers | undefined;
// Typed as `Response` because msw's own return type is generic in the body;
// the handler only needs to hand it back.
let reply: () => Response = () => HttpResponse.json(okMessage());

const server = setupServer(
  http.post(MESSAGES_URL, async ({ request }) => {
    lastBody = await request.json();
    lastHeaders = request.headers;
    return reply();
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  reply = () => HttpResponse.json(okMessage());
  lastBody = undefined;
  lastHeaders = undefined;
});

function client(modelId = 'claude-opus-5') {
  return createAnthropicClient({
    apiKey: secret('sk-ant-test-key'),
    modelId,
    post: createAxiosJsonPoster(),
    baseUrl: 'https://api.anthropic.test',
  });
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    system: 'You are a research agent.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Why is the sky blue?' }] }],
    tools: [
      {
        name: 'web_search',
        description: 'Search the web.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        timeoutMs: 10_000,
      },
    ],
    maxOutputTokens: 4096,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function okMessage(
  content: unknown[] = [{ type: 'text', text: 'Hello.' }],
  stopReason = 'end_turn',
) {
  return {
    id: 'msg_1',
    model: 'claude-opus-5-20260101',
    role: 'assistant',
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 120, output_tokens: 34 },
  };
}

describe('the request it sends', () => {
  it('takes the model from config rather than a string in this file', async () => {
    await client('claude-sonnet-5').complete(request());

    expect(lastBody).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 4096 });
  });

  it('authenticates with the key in a header and nowhere else', async () => {
    await client().complete(request());

    expect(lastHeaders?.get('x-api-key')).toBe('sk-ant-test-key');
    expect(lastHeaders?.get('anthropic-version')).toBe('2023-06-01');
    // The one thing that must never end up in a request body or a log line.
    expect(JSON.stringify(lastBody)).not.toContain('sk-ant-test-key');
  });

  it('hands the model the same JSON Schema the registry validates against', async () => {
    await client().complete(request());

    expect(lastBody).toMatchObject({
      tools: [
        {
          name: 'web_search',
          description: 'Search the web.',
          input_schema: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    });
  });

  it('maps a tool result back into the vendor shape', async () => {
    await client().complete(
      request({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'calculator', input: { a: 1 } }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'toolu_1', content: '{"value":2}', isError: false },
            ],
          },
        ],
      }),
    );

    expect(lastBody).toMatchObject({
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'calculator' }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: '{"value":2}',
              is_error: false,
            },
          ],
        },
      ],
    });
  });

  it('leaves thinking configuration to the model, because MODEL_ID is a deploy choice', async () => {
    await client().complete(request());

    expect(lastBody).not.toHaveProperty('thinking');
  });
});

describe('the response it returns', () => {
  it('normalises text, tool calls and usage', async () => {
    reply = () =>
      HttpResponse.json(
        okMessage(
          [
            { type: 'text', text: 'Searching first.' },
            { type: 'tool_use', id: 'toolu_9', name: 'web_search', input: { query: 'sky' } },
          ],
          'tool_use',
        ),
      );

    const response: LlmResponse = await client().complete(request());

    expect(response.stopReason).toBe('tool_use');
    expect(response.usage).toStrictEqual({ inputTokens: 120, outputTokens: 34 });
    // The resolved model id, not the alias asked for — the trace should say what
    // actually answered.
    expect(response.modelId).toBe('claude-opus-5-20260101');
    expect(response.content).toStrictEqual([
      { type: 'text', text: 'Searching first.' },
      { type: 'tool_use', id: 'toolu_9', name: 'web_search', input: { query: 'sky' } },
    ]);
  });

  it('normalises a stop reason it has never seen rather than failing', async () => {
    reply = () => HttpResponse.json(okMessage([{ type: 'text', text: 'ok' }], 'pause_turn'));

    expect((await client().complete(request())).stopReason).toBe('other');
  });

  it('ends the run on a refusal instead of nudging a model that will not answer', async () => {
    reply = () => HttpResponse.json(okMessage([], 'refusal'));

    await expect(client().complete(request())).rejects.toThrow(/declined to answer/u);
  });

  it('rejects a body it cannot read', async () => {
    reply = () => HttpResponse.json({ nonsense: true });

    await expect(client().complete(request())).rejects.toBeInstanceOf(LlmError);
  });
});

describe('a thinking block', () => {
  const thinking = {
    type: 'thinking',
    thinking: 'The user wants a physical explanation.',
    signature: 'sig_abc123',
  };

  it('is carried through opaquely rather than dropped', async () => {
    reply = () => HttpResponse.json(okMessage([thinking, { type: 'text', text: 'Hello.' }]));

    const response = await client().complete(request());

    expect(response.content[0]).toStrictEqual({ type: 'opaque', vendor: thinking });
  });

  it('goes back to the API byte-for-byte on the next turn', async () => {
    // A model with thinking enabled rejects a conversation whose thinking blocks
    // were dropped or edited, so this round trip is what makes turn two work.
    reply = () => HttpResponse.json(okMessage([thinking, { type: 'text', text: 'Hello.' }]));
    const first = await client().complete(request());

    await client().complete(request({ messages: [{ role: 'assistant', content: first.content }] }));

    expect(lastBody).toMatchObject({
      messages: [{ role: 'assistant', content: [thinking, { type: 'text', text: 'Hello.' }] }],
    });
  });
});

describe('when the API fails', () => {
  it('reports the provider’s own message', async () => {
    reply = () =>
      HttpResponse.json(
        {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'max_tokens too large' },
        },
        { status: 400 },
      );

    await expect(client().complete(request())).rejects.toThrow(/400: max_tokens too large/u);
  });

  it('marks a rate limit as worth retrying and a bad request as not', async () => {
    reply = () => HttpResponse.json({ error: { message: 'rate limited' } }, { status: 429 });
    const rateLimited = await client()
      .complete(request())
      .catch((error: unknown) => error);

    reply = () => HttpResponse.json({ error: { message: 'bad' } }, { status: 400 });
    const badRequest = await client()
      .complete(request())
      .catch((error: unknown) => error);

    expect(isTransient(rateLimited)).toBe(true);
    expect(isTransient(badRequest)).toBe(false);
  });

  it('never puts the key in the error it raises', async () => {
    reply = () => HttpResponse.json({ error: { message: 'nope' } }, { status: 401 });

    const error = await client()
      .complete(request())
      .catch((caught: unknown) => caught);

    expect(String(error)).not.toContain('sk-ant-test-key');
  });

  it('stops when the run is aborted', async () => {
    const aborted = AbortSignal.abort();

    await expect(client().complete(request({ signal: aborted }))).rejects.toThrow();
  });
});
