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

function deps(body: string, contentType = 'text/html', address = '93.184.216.34'): GuardedGetDeps {
  const http: HttpClient = {
    get: () =>
      Promise.resolve({
        status: 200,
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

  it('explains an unreadable content type', async () => {
    const tool = createHttpGetTool(deps('%PDF-1.4', 'application/pdf'));
    await expect(tool.execute({ url: 'https://example.com/a.pdf' }, ctx)).rejects.toThrow(
      /not readable text/u,
    );
  });

  it('flags a truncated excerpt rather than silently shortening it', async () => {
    const tool = createHttpGetTool(deps('x'.repeat(5_000), 'text/plain'));
    const output = await tool.execute({ url: 'https://example.com/long' }, ctx);

    expect(output.truncated).toBe(true);
    expect(output.textExcerpt).toHaveLength(4_000);
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

  it('leaves non-html alone, so json stays parseable', () => {
    const json = '{"a": 1}';
    expect(extractText(json, 'application/json')).toBe(json);
  });
});
