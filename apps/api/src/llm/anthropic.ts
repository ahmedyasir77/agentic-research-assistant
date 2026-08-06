import { JsonValueSchema, type JsonValue, type ToolSpec } from '@ara/shared';
import { z } from 'zod';

import type { Secret } from '../config/secret.ts';
import type { JsonPoster } from '../platform/jsonPost.ts';
import {
  LlmError,
  LlmResponseSchema,
  type AssistantBlock,
  type ContentBlock,
  type LlmClient,
  type LlmMessage,
  type LlmResponse,
  type StopReason,
} from './port.ts';

/**
 * The Messages API, mapped to the port and back.
 *
 * This is the only file in the codebase that knows a vendor field name. Above the
 * `LlmClient` seam everything is normalised, which is what lets the same agent
 * loop run against a recorded script offline and a real model live.
 */
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** The version of the wire format this adapter was written against. */
const API_VERSION = '2023-06-01';

/**
 * Generous, because a reasoning model working through a hard question is slow.
 * The run's own wall-clock budget aborts sooner via the signal, so this is only
 * the backstop for a request that has gone silent.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AnthropicClientDeps {
  readonly apiKey: Secret;
  /** From MODEL_ID. Never hardcoded — the model is a deploy-time choice. */
  readonly modelId: string;
  readonly post: JsonPoster;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export function createAnthropicClient(deps: AnthropicClientDeps): LlmClient {
  const url = `${deps.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`;

  return {
    modelId: deps.modelId,

    complete: async (request) => {
      const response = await deps.post({
        url,
        headers: {
          // The only place the key is ever exposed, and the call is greppable.
          'x-api-key': deps.apiKey.expose(),
          'anthropic-version': API_VERSION,
        },
        body: {
          model: deps.modelId,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          tools: request.tools.map(toVendorTool),
          messages: request.messages.map(toVendorMessage),
          // `thinking` is deliberately not sent. It is configured per model — the
          // parameter that is required on one is rejected on another — and MODEL_ID
          // is a deployment choice, so each model is left to its own default.
        },
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: request.signal,
      });

      if (response.status !== 200) throw toLlmError(response.status, response.data);
      return normalise(response.data);
    },
  };
}

/** The tool's JSON Schema is the same object the registry validates against. */
function toVendorTool(tool: ToolSpec): JsonValue {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function toVendorMessage(message: LlmMessage): JsonValue {
  return { role: message.role, content: message.content.map(toVendorBlock) };
}

function toVendorBlock(block: ContentBlock): JsonValue {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
    case 'opaque':
      // Straight back out the way it came in. Editing a thinking block — even
      // reformatting it — is what makes the next turn fail.
      return block.vendor;
  }
}

const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

/**
 * Deliberately loose about `content`: blocks are parsed one at a time so a block
 * type this adapter has never heard of is carried rather than rejected. A new
 * vendor block type should not take a run down.
 */
const MessageSchema = z.object({
  model: z.string().min(1),
  content: z.array(JsonValueSchema),
  stop_reason: z.string().nullable(),
  usage: UsageSchema,
});

const VendorTextSchema = z.object({ type: z.literal('text'), text: z.string() });
const VendorToolUseSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: JsonValueSchema,
});

function normalise(data: unknown): LlmResponse {
  const parsed = MessageSchema.safeParse(data);
  if (!parsed.success) {
    throw new LlmError('The model returned a response this adapter could not read.', {
      cause: parsed.error,
    });
  }
  const message = parsed.data;

  // A refusal is a real answer to the request, not a transport failure — but it is
  // an answer the loop cannot act on, so it ends the run with its own reason
  // rather than being nudged toward a `finish` call it will never make.
  if (message.stop_reason === 'refusal') {
    throw new LlmError('The model declined to answer this request.');
  }

  return LlmResponseSchema.parse({
    content: message.content.map(toPortBlock),
    stopReason: toStopReason(message.stop_reason),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
    modelId: message.model,
  });
}

function toPortBlock(block: JsonValue): AssistantBlock {
  const text = VendorTextSchema.safeParse(block);
  if (text.success) return { type: 'text', text: text.data.text };

  const toolUse = VendorToolUseSchema.safeParse(block);
  if (toolUse.success) {
    return {
      type: 'tool_use',
      id: toolUse.data.id,
      name: toolUse.data.name,
      input: toolUse.data.input,
    };
  }

  return { type: 'opaque', vendor: block };
}

/** Anything the loop has no specific handling for is normalised to `other`. */
function toStopReason(raw: string | null): StopReason {
  switch (raw) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'refusal':
      return raw;
    default:
      return 'other';
  }
}

const ErrorBodySchema = z.object({
  error: z.object({ type: z.string().optional(), message: z.string() }),
});

/**
 * The error carries the status on itself so `platform/transient.ts` can classify
 * it — a 429 or a 503 is worth retrying, a 400 is the same mistake made slower.
 */
function toLlmError(status: number, data: unknown): LlmError {
  const parsed = ErrorBodySchema.safeParse(data);
  const detail = parsed.success ? parsed.data.error.message : 'no error detail was returned';
  return new LlmError(`The model API returned ${String(status)}: ${detail}`, { status });
}
