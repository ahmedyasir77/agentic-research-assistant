import { describe, expect, it } from 'vitest';

import { SHARED_CONTRACT_VERSION } from './index.ts';

describe('shared contract', () => {
  it('is versioned so a stale browser tab can detect an incompatible API', () => {
    expect(SHARED_CONTRACT_VERSION).toBe(1);
  });
});
