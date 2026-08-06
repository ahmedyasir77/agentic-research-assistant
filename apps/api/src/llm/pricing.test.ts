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

  it('prices a dated model id the same as its bare form', () => {
    // Both are valid in MODEL_ID. A live run against
    // `claude-haiku-4-5-20251001` reported five times its real cost before this,
    // because only the bare id was in the table.
    const usage = { inputTokens: 15_448, outputTokens: 962 };

    expect(estimateCostUsd('claude-haiku-4-5-20251001', usage)).toBe(
      estimateCostUsd('claude-haiku-4-5', usage),
    );
    expect(estimateCostUsd('claude-haiku-4-5-20251001', usage)).toBeCloseTo(0.0203, 4);
    expect(isPricingKnown('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('does not mistake a version number for a date suffix', () => {
    // `claude-opus-4-8` must not be mangled into `claude-opus`.
    expect(isPricingKnown('claude-opus-4-8')).toBe(true);
    expect(estimateCostUsd('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(5);
  });
});
