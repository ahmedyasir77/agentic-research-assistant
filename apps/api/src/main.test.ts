import { AgentEventSchema, EVENT_SCHEMA_VERSION } from '@ara/shared';
import { describe, expect, it } from 'vitest';

describe('workspace wiring', () => {
  // Cheap, but it fails loudly if the shared package's exports map, build output
  // or module resolution stops working — a class of break that otherwise only
  // shows up at runtime, in the browser, during a demo.
  it('resolves the shared contract package from the api', () => {
    expect(EVENT_SCHEMA_VERSION).toBe(2);
    expect(AgentEventSchema.safeParse({ type: 'nonsense' }).success).toBe(false);
  });
});
