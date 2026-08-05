import { JsonValueSchema, TokenUsageSchema, type ToolSpec } from '@ara/shared';
import { z } from 'zod';

/**
 * The seam between the agent and whoever is generating tokens.
 *
 * Everything here is normalised: no vendor field names, no vendor types. The
 * Anthropic adapter maps to and from these shapes at its own boundary and nothing
 * above this line knows which model — or whether a model at all — is answering.
 * That is what lets the same loop run against a recorded script in offline mode.
 */

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  /** Correlates the call with its result; the model chooses it, we echo it back. */
  id: z.string().min(1),
  name: z.string().min(1),
  input: JsonValueSchema,
});

export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string().min(1),
  content: z.string(),
  /** A failed tool call is a result, not an exception — this is how the model learns. */
  isError: z.boolean(),
});

export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;

/** What a model may say back to us. */
export const AssistantBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ToolUseBlockSchema,
]);
export type AssistantBlock = z.infer<typeof AssistantBlockSchema>;

/** What may appear anywhere in a conversation. */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const LlmMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(ContentBlockSchema),
});
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

export const StopReasonSchema = z.enum([
  'end_turn',
  'tool_use',
  'max_tokens',
  'refusal',
  /** Anything a vendor invents that the loop has no specific handling for. */
  'other',
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const LlmResponseSchema = z.object({
  content: z.array(AssistantBlockSchema),
  stopReason: StopReasonSchema,
  usage: TokenUsageSchema,
  modelId: z.string(),
});
export type LlmResponse = z.infer<typeof LlmResponseSchema>;

export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly ToolSpec[];
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}

export interface LlmClient {
  /** The model's identifier, for the trace and for cost estimation. */
  readonly modelId: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** A failure from the model provider that the run cannot recover from. */
export class LlmError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LlmError';
  }
}

/** Convenience for the loop and the tests: the tool calls in a response, in order. */
export function toolUses(response: LlmResponse): readonly ToolUseBlock[] {
  return response.content.filter((block) => block.type === 'tool_use');
}

/** The model's visible reasoning for a turn, joined into one string for the trace. */
export function assistantText(response: LlmResponse): string {
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
