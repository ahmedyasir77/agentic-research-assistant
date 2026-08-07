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

describe('citations that arrived one layer too deep', () => {
  const citation = {
    id: 1,
    url: 'https://example.com/a',
    title: 'A',
    quote: 'A sentence long enough to be evidence.',
  };

  it('accepts a citations array the model serialised as a json string', () => {
    const parsed = FinishPayloadSchema.safeParse({
      answer: 'An answer. [1]',
      citations: JSON.stringify([citation]),
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.citations).toStrictEqual([citation]);
  });

  it('still takes a real array, and still defaults to none', () => {
    expect(FinishPayloadSchema.safeParse({ answer: 'a', citations: [citation] })).toMatchObject({
      success: true,
    });
    expect(FinishPayloadSchema.parse({ answer: 'a' }).citations).toStrictEqual([]);
  });

  it('reports the real error for a string that is not an array', () => {
    const parsed = FinishPayloadSchema.safeParse({ answer: 'a', citations: 'see above' });

    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues[0]?.message).toMatch(/expected array/u);
  });

  it('rejects a stringified array whose contents are not citations', () => {
    const parsed = FinishPayloadSchema.safeParse({
      answer: 'a',
      citations: JSON.stringify([{ id: 'one' }]),
    });

    expect(parsed.success).toBe(false);
  });
});

describe('a quote longer than the cap', () => {
  const long = `${'The sentence that carries the claim. '.repeat(20)}tail`;

  function citation(quote: string) {
    return { id: 1, url: 'https://example.com/a', title: 'A', quote };
  }

  it('trims the quote instead of rejecting the whole finish call', async () => {
    // The rejection threw away the answer and every other citation to fix a few
    // characters at the end of one quote, and the model had to regenerate all of it.
    // A real run spent its last steps that way and died holding a finished answer.
    const { outcome } = await registry.invoke(
      'finish',
      { answer: 'An answer. [1]', citations: [citation(long)] },
      ctx(),
    );

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    const [parsed] = FinishPayloadSchema.parse(outcome.output).citations;
    expect(parsed?.quote).toHaveLength(500);
  });

  it('keeps a prefix, so a quote really in the page still matches it', () => {
    // Quotes are located by substring search, so trimming can only weaken the match,
    // never invent one: a prefix of text in the page is still in the page, and a
    // prefix of a recalled sentence is still not.
    const parsed = FinishPayloadSchema.parse({ answer: 'a', citations: [citation(long)] });

    expect(long.startsWith(parsed.citations[0]?.quote ?? '')).toBe(true);
  });

  it('leaves a quote within the cap exactly as it arrived', () => {
    const quote = 'A sentence long enough to be evidence.';
    const parsed = FinishPayloadSchema.parse({ answer: 'a', citations: [citation(quote)] });

    expect(parsed.citations[0]?.quote).toBe(quote);
  });

  it('tells the model the limit, so trimming stays the floor rather than the path', () => {
    expect(JSON.stringify(registry.toModelSpecs()[0]?.inputSchema)).toContain('under 500');
  });
});
