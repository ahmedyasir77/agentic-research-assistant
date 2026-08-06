import type { TokenUsage } from '@ara/shared';

/**
 * Cost estimation for the trace. It is an estimate and the UI says so: it prices
 * tokens at list rates and knows nothing about caching, batch discounts or the
 * negotiated rate an organisation actually pays.
 *
 * It is here anyway because "what did that run cost" is the first question anyone
 * asks about an agent, and a number that is roughly right beats no number.
 */
interface ModelPricing {
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

const PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-opus-5': { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  'claude-opus-4-8': { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  'claude-sonnet-5': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-haiku-4-5': { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
  /** The offline demo bills nothing, and the UI should show that honestly. */
  'fake-model': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
};

/** An unknown model is priced at the Opus tier, so a surprise is expensive, not free. */
const FALLBACK: ModelPricing = { inputPerMillionUsd: 5, outputPerMillionUsd: 25 };

export function estimateCostUsd(modelId: string, usage: TokenUsage): number {
  const pricing = pricingFor(modelId) ?? FALLBACK;
  const input = (usage.inputTokens / 1_000_000) * pricing.inputPerMillionUsd;
  const output = (usage.outputTokens / 1_000_000) * pricing.outputPerMillionUsd;
  return input + output;
}

export function isPricingKnown(modelId: string): boolean {
  return pricingFor(modelId) !== undefined;
}

/**
 * Model ids are published both bare (`claude-haiku-4-5`) and dated
 * (`claude-haiku-4-5-20251001`), and both are valid in `MODEL_ID`. Matching only
 * the exact string meant a dated id fell through to the fallback tier — a real
 * live run against Haiku reported a cost five times its actual one.
 */
function pricingFor(modelId: string): ModelPricing | undefined {
  return PRICING[modelId] ?? PRICING[modelId.replace(/-\d{8}$/u, '')];
}
