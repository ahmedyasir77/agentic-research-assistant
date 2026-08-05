import { describe, expect, it } from 'vitest';

import { estimateCostUsd, isPricingKnown } from './pricing.ts';

describe('estimateCostUsd', () => {
  it('prices a million input tokens at the published rate', () => {
    expect(estimateCostUsd('claude-opus-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(5);
  });

  it('prices output higher than input, as every model does', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostUsd('claude-opus-5', usage)).toBe(30);
  });

  it('prices a realistic run in fractions of a cent', () => {
    const cost = estimateCostUsd('claude-opus-5', { inputTokens: 7_770, outputTokens: 650 });
    expect(cost).toBeCloseTo(0.0551, 4);
  });

  it('charges nothing for the offline demo, and says so honestly', () => {
    expect(estimateCostUsd('fake-model', { inputTokens: 10_000, outputTokens: 5_000 })).toBe(0);
  });

  it('falls back to the most expensive tier for an unknown model', () => {
    // A surprise should overstate the bill, not hide it.
    const unknown = estimateCostUsd('claude-something-new', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(unknown).toBe(5);
    expect(isPricingKnown('claude-something-new')).toBe(false);
  });

  it('is zero for a run that used no tokens', () => {
    expect(estimateCostUsd('claude-opus-5', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});
