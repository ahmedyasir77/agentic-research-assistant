import { describe, expect, it } from 'vitest';

import { silentLogger } from '../platform/logger.ts';
import { createFinishTool, FinishPayloadSchema } from './finish.ts';
import { ToolRegistry } from './registry.ts';

const registry = new ToolRegistry([createFinishTool()], { now: () => 0 });

function ctx() {
  return {
    runId: 'run_test',
    step: 0,
    signal: new AbortController().signal,
    logger: silentLogger,
  };
}

describe('the finish tool', () => {
  it('accepts an answer that rests on no source', async () => {
    // A run that only did arithmetic has nothing to cite. Requiring the field cost
    // a real live run four steps and then the whole run: the model sent a correct
    // answer with no citations key and was rejected every time.
    const { outcome } = await registry.invoke(
      'finish',
      { answer: 'Air scatters 450nm light about 5.86 times more strongly than 700nm light.' },
      ctx(),
    );

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(FinishPayloadSchema.parse(outcome.output).citations).toStrictEqual([]);
  });

  it('tells the model the field is optional', () => {
    const spec = registry.toModelSpecs()[0];

    expect(JSON.stringify(spec?.inputSchema)).toContain('empty array');
    // Only `answer` is required — the schema the model reads has to agree with the
    // schema it is validated against, because they are the same object.
    expect(JSON.stringify(spec?.inputSchema)).toContain('"required":["answer"]');
  });

  it('still rejects an answer that is missing entirely', async () => {
    const { outcome } = await registry.invoke('finish', { citations: [] }, ctx());

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error.kind).toBe('invalid_arguments');
  });

  it('still rejects a citation that is not a real url', async () => {
    const { outcome } = await registry.invoke(
      'finish',
      { answer: 'Something.', citations: [{ id: 1, url: 'not-a-url', title: 'x' }] },
      ctx(),
    );

    expect(outcome.status).toBe('error');
  });
});
