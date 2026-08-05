import { SHARED_CONTRACT_VERSION } from '@ara/shared';
import { describe, expect, it } from 'vitest';

describe('workspace wiring', () => {
  // Cheap, but it fails loudly if the shared package's exports map, build output
  // or module resolution stops working — a class of break that otherwise only
  // shows up at runtime.
  it('resolves the shared contract package from the api', () => {
    expect(SHARED_CONTRACT_VERSION).toBe(1);
  });
});
