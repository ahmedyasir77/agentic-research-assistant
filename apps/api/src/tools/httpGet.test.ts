import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { GuardedGetDeps } from '../platform/guardedGet.ts';
import type { HttpClient } from '../platform/httpClient.ts';
import { silentLogger } from '../platform/logger.ts';
import type { DnsResolver } from '../platform/ssrf.ts';
import { createHttpGetTool, extractText } from './httpGet.ts';
import { ToolExecutionError, type ToolContext } from './types.ts';

const ctx: ToolContext = {
  runId: 'run_1',
  step: 0,
  signal: new AbortController().signal,
  logger: silentLogger,
};

function deps(
  body: string,
  contentType = 'text/html',
  address = '93.184.216.34',
  status = 200,
): GuardedGetDeps {
  const http: HttpClient = {
    get: () =>
      Promise.resolve({
        status,
        headers: { 'content-type': contentType },
        body: Readable.from([body]),
      }),
  };
  const resolveDns: DnsResolver = () => Promise.resolve([{ address, family: 4 }]);
  return { http, resolveDns };
}

describe('http_get', () => {
  it('returns readable text from an html page', async () => {
    const tool = createHttpGetTool(
      deps('<html><body><h1>Optics</h1><p>Blue sky.</p></body></html>'),
    );
    const output = await tool.execute({ url: 'https://example.com/optics' }, ctx);

    expect(output.status).toBe(200);
    expect(output.contentType).toBe('text/html');
    expect(output.textExcerpt).toBe('Optics Blue sky.');
    expect(output.finalUrl).toBe('https://example.com/optics');
  });

  it('explains a blocked url instead of just failing', async () => {
    const tool = createHttpGetTool(deps('', 'text/html', '169.254.169.254'));
    const promise = tool.execute({ url: 'http://metadata.example.com/' }, ctx);

    await expect(promise).rejects.toThrow(ToolExecutionError);
    await expect(promise).rejects.toThrow(/Pick a different, public URL/u);
  });

  it('refuses a bot challenge instead of returning it as the page', async () => {
    // The exact shape that produced false citations: a Vercel checkpoint served as
    // real HTML from the real URL, with a 429 beside it that nothing looked at.
    const challenge =
      '<html><body>Vercel Security Checkpoint We&#8217;re verifying your browser</body></html>';
    const tool = createHttpGetTool(deps(challenge, 'text/html', '93.184.216.34', 429));
    const promise = tool.execute({ url: 'https://example.com/blog/post' }, ctx);

    await expect(promise).rejects.toThrow(ToolExecutionError);
    await expect(promise).rejects.toThrow(/refusing automated readers/u);
    await expect(promise).rejects.toThrow(/Do not cite this page/u);
  });

  it.each([
    [404, /gone or the URL is wrong/u],
    [403, /refusing automated readers/u],
    [503, /failing right now/u],
    [418, /not a page that can be read/u],
  ])('turns a %i into advice the model can act on', async (status, expected) => {
    const tool = createHttpGetTool(deps('<p>nope</p>', 'text/html', '93.184.216.34', status));
    const promise = tool.execute({ url: 'https://example.com/a' }, ctx);

    await expect(promise).rejects.toThrow(expected);
    await expect(promise).rejects.toThrow(/Do not cite this page/u);
  });

  it('explains an unreadable content type', async () => {
    const tool = createHttpGetTool(deps('%PDF-1.4', 'application/pdf'));
    await expect(tool.execute({ url: 'https://example.com/a.pdf' }, ctx)).rejects.toThrow(
      /not readable text/u,
    );
  });

  it('flags a truncated excerpt rather than silently shortening it', async () => {
    const tool = createHttpGetTool(deps('x'.repeat(20_000), 'text/plain'));
    const output = await tool.execute({ url: 'https://example.com/long' }, ctx);

    expect(output.truncated).toBe(true);
    expect(output.textExcerpt).toHaveLength(12_000);
    // Enough to act on: where this piece started, how much page there is, and where
    // the next read picks up.
    expect(output.offset).toBe(0);
    expect(output.totalChars).toBe(20_000);
    // Back from the cut by the quote cap, not to it: the next read has to include
    // the sentence this one ran through the middle of.
    expect(output.nextOffset).toBe(11_500);
  });

  it('reads on from an offset so a long page can be finished', async () => {
    // The sentence worth citing is past the first excerpt — the case that used to
    // end with the model quoting a page it had only partly seen.
    const page = `${'x'.repeat(13_000)}The endowment is larger than the GDP of some countries.`;
    const tool = createHttpGetTool(deps(page, 'text/plain'));

    const first = await tool.execute({ url: 'https://example.com/long' }, ctx);
    expect(first.textExcerpt).not.toContain('endowment');

    const second = await tool.execute(
      { url: 'https://example.com/long', offset: first.nextOffset },
      ctx,
    );

    expect(second.offset).toBe(11_500);
    expect(second.textExcerpt).toContain('The endowment is larger than');
    expect(second.truncated).toBe(false);
    expect(second.nextOffset).toBeUndefined();
  });

  it('overlaps consecutive reads, so no sentence falls in the gap between them', async () => {
    // The failure this exists for: a page cut at a raw character count splits a
    // sentence, the halves reach the grounding check as separate evidence, and a
    // quote spanning them matches neither — the agent is told the page does not
    // contain words that are plainly in it.
    const sentence =
      'In a University of Chicago study on sleep deprivation, the volunteers who stayed awake ' +
      'showed measurable metabolic changes within a week.';
    const cut = 40; // How much of the sentence lands in the first excerpt.
    const page = `${'x'.repeat(12_000 - cut)}${sentence}${'y'.repeat(2_000)}`;
    const tool = createHttpGetTool(deps(page, 'text/plain'));

    const first = await tool.execute({ url: 'https://example.com/long' }, ctx);
    const second = await tool.execute(
      { url: 'https://example.com/long', offset: first.nextOffset },
      ctx,
    );

    // Split by the first read, whole in the second. Every quote the schema permits
    // is at most the overlap long, so this holds for all of them, not just this one.
    expect(first.textExcerpt).not.toContain(sentence);
    expect(second.textExcerpt).toContain(sentence);
  });

  it('does not hand back an offset before the read that produced it', async () => {
    // Defensive: were an excerpt ever shorter than the overlap, backing off by the
    // full overlap would point behind the current read and the model would loop
    // over the same text instead of finishing the page.
    const tool = createHttpGetTool(deps('x'.repeat(20_000), 'text/plain'));
    const output = await tool.execute({ url: 'https://example.com/long', offset: 7_000 }, ctx);

    expect(output.nextOffset).toBeGreaterThan(output.offset);
  });

  it('returns the whole of a page that fits, and says there is no more', async () => {
    const tool = createHttpGetTool(deps('<p>Short and complete.</p>'));
    const output = await tool.execute({ url: 'https://example.com/short' }, ctx);

    expect(output.truncated).toBe(false);
    expect(output.nextOffset).toBeUndefined();
    expect(output.totalChars).toBe('Short and complete.'.length);
  });

  it('clamps an offset past the end instead of failing the call', async () => {
    const tool = createHttpGetTool(deps('short', 'text/plain'));
    const output = await tool.execute({ url: 'https://example.com/short', offset: 9_999 }, ctx);

    // An empty excerpt next to the real length tells the model it overshot, which
    // it can act on; an error is one more thing to recover from.
    expect(output.textExcerpt).toBe('');
    expect(output.offset).toBe(5);
    expect(output.totalChars).toBe(5);
    expect(output.truncated).toBe(false);
  });

  it('serves a continuing read from cache instead of refetching the page', async () => {
    let calls = 0;
    const page = `${'x'.repeat(13_000)}The endowment is larger than the GDP of some countries.`;
    const http: HttpClient = {
      get: () => {
        calls += 1;
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: Readable.from([page]),
        });
      },
    };
    const resolveDns: DnsResolver = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
    const tool = createHttpGetTool({ http, resolveDns });

    const first = await tool.execute({ url: 'https://example.com/long' }, ctx);
    expect(calls).toBe(1);

    const second = await tool.execute(
      { url: 'https://example.com/long', offset: first.nextOffset },
      ctx,
    );
    expect(calls).toBe(1);
    expect(second.textExcerpt).toContain('The endowment is larger than');
  });

  it('refetches once the cache entry has expired', async () => {
    let calls = 0;
    const http: HttpClient = {
      get: () => {
        calls += 1;
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: Readable.from(['fresh each time']),
        });
      },
    };
    const resolveDns: DnsResolver = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
    let clock = 0;
    const tool = createHttpGetTool({ http, resolveDns }, { now: () => clock });

    await tool.execute({ url: 'https://example.com/a' }, ctx);
    expect(calls).toBe(1);

    clock += 5 * 60_000 + 1;
    await tool.execute({ url: 'https://example.com/a' }, ctx);
    expect(calls).toBe(2);
  });

  it('rejects a negative offset before any request is made', () => {
    const tool = createHttpGetTool(deps(''));
    expect(tool.inputSchema.safeParse({ url: 'https://example.com', offset: -1 }).success).toBe(
      false,
    );
  });

  it('rejects a non-url before any request is made', () => {
    const tool = createHttpGetTool(deps(''));
    expect(tool.inputSchema.safeParse({ url: 'not a url' }).success).toBe(false);
  });
});

describe('extractText', () => {
  it('drops script and style content, which is never prose', () => {
    const html = '<p>Keep</p><script>alert(1)</script><style>p{color:red}</style><p>This</p>';
    expect(extractText(html, 'text/html')).toBe('Keep This');
  });

  it('drops comments', () => {
    expect(extractText('<p>a</p><!-- hidden --><p>b</p>', 'text/html')).toBe('a b');
  });

  it('decodes the entities that actually show up in prose', () => {
    expect(extractText('<p>Tom &amp; Jerry &lt;3 &quot;x&quot;&nbsp;y</p>', 'text/html')).toBe(
      'Tom & Jerry <3 "x" y',
    );
  });

  it('decodes numeric references, which publishing platforms emit mid-sentence', () => {
    // The shape that broke citations: a page writing the same apostrophe two ways.
    expect(
      extractText('<p>these universities&#8217; mission and Harvard&#x2019;s too</p>', 'text/html'),
    ).toBe('these universities’ mission and Harvard’s too');
    expect(extractText('<p>Tuition &#038; Cost &#8211; 2026</p>', 'text/html')).toBe(
      'Tuition & Cost – 2026',
    );
  });

  it('keeps a double-encoded reference literal rather than decoding it twice', () => {
    expect(extractText('<p>write &amp;#8217; for an apostrophe</p>', 'text/html')).toBe(
      'write &#8217; for an apostrophe',
    );
    expect(extractText('<p>write &#38;lt; for a less-than</p>', 'text/html')).toBe(
      'write &lt; for a less-than',
    );
  });

  it('leaves a reference that is not a usable code point as written', () => {
    expect(extractText('<p>&#0; &#1114112; ok</p>', 'text/html')).toBe('&#0; &#1114112; ok');
  });

  it('leaves non-html alone, so json stays parseable', () => {
    const json = '{"a": 1}';
    expect(extractText(json, 'application/json')).toBe(json);
  });
});
