import { describe, expect, it, vi } from 'vitest';

import { createAgentRuntime } from './composition.ts';
import { loadConfig } from './config/env.ts';
import { defaultFixturesDir } from './config/paths.ts';
import { assistantText, toolUses } from './llm/port.ts';
import { FinishPayloadSchema } from './tools/finish.ts';
import { silentLogger } from './platform/logger.ts';
import type { ToolContext } from './tools/types.ts';

/**
 * The offline demo, exercised end to end without the agent loop: replay the
 * recorded model turns and run every tool call the script makes through the real
 * registry, the real schemas and the real SSRF guard.
 *
 * This is the test that has to keep passing for `pnpm demo` to be trustworthy on
 * a conference network.
 */
const config = loadConfig({
  DEMO_MODE: 'offline',
  SEARCH_PROVIDER: 'fixture',
  LOG_LEVEL: 'silent',
});
const runtime = createAgentRuntime({ config, logger: silentLogger });

function ctx(step: number): ToolContext {
  return { runId: 'run_offline', step, signal: new AbortController().signal, logger: silentLogger };
}

describe('offline run for the recorded demo query', () => {
  it('replays every step and ends with a cited answer', async () => {
    const llm = await runtime.llmFor('Why is the sky blue?');
    const seenUrls = new Set<string>();
    const toolNames: string[] = [];
    let answer = '';
    let citations: readonly { url: string }[] = [];

    for (let step = 0; step < 8; step += 1) {
      const response = await llm.complete({
        system: 'test',
        messages: [],
        tools: runtime.tools.toModelSpecs(),
        maxOutputTokens: 4_096,
        signal: ctx(step).signal,
      });

      const calls = toolUses(response);
      if (calls.length === 0) break;

      for (const call of calls) {
        toolNames.push(call.name);
        const { outcome } = await runtime.tools.invoke(call.name, call.input, ctx(step));

        expect(outcome.status, `${call.name} on step ${String(step)}`).toBe('ok');
        if (outcome.status !== 'ok') return;

        collectUrls(outcome.output, seenUrls);

        if (call.name === 'finish') {
          // Parsed with the production schema, so the fixture is held to exactly
          // the contract the agent loop will hold it to.
          const parsed = FinishPayloadSchema.parse(outcome.output);
          answer = parsed.answer;
          citations = parsed.citations;
        }
      }

      if (toolNames.includes('finish')) break;
    }

    expect(toolNames).toStrictEqual(['web_search', 'http_get', 'calculator', 'finish']);
    expect(answer).toContain('Rayleigh scattering');
    expect(citations).toHaveLength(2);

    // The point of the whole exercise: every cited URL was actually returned by a
    // tool during this run, so the citation check in M4 has something real to verify.
    for (const citation of citations) {
      expect(seenUrls, `citation ${citation.url}`).toContain(citation.url);
    }
  });

  it('reads the recorded page through the real guard, not the network', async () => {
    const { outcome } = await runtime.tools.invoke(
      'http_get',
      { url: 'https://en.wikipedia.org/wiki/Rayleigh_scattering' },
      ctx(0),
    );

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    const output = outcome.output;
    expect(JSON.stringify(output)).toContain('fourth power');
    // Script and style survived the fixture but not the extractor.
    expect(JSON.stringify(output)).not.toContain('trackPageView');
  });

  it('still enforces the SSRF policy on a recorded run', async () => {
    const { outcome } = await runtime.tools.invoke(
      'http_get',
      { url: 'http://169.254.169.254/latest/meta-data/' },
      ctx(0),
    );

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error.message).toMatch(/link-local/u);
  });

  it('makes no outbound network call', async () => {
    // If any adapter reached for the network it would go through global fetch or
    // a socket; the fixture transports mean neither is touched.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const llm = await runtime.llmFor('Why is the sky blue?');
    await llm.complete({
      system: 'test',
      messages: [],
      tools: [],
      maxOutputTokens: 100,
      signal: ctx(0).signal,
    });
    await runtime.tools.invoke(
      'web_search',
      { query: 'why is the sky blue', maxResults: 3 },
      ctx(0),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('offline run for an unscripted query', () => {
  it('falls back to a default script rather than failing', async () => {
    const llm = await runtime.llmFor('what is the airspeed velocity of an unladen swallow');
    const first = await llm.complete({
      system: 'test',
      messages: [],
      tools: [],
      maxOutputTokens: 100,
      signal: ctx(0).signal,
    });

    expect(assistantText(first)).toContain('do not have a recorded script');
    expect(toolUses(first)[0]?.name).toBe('web_search');
  });

  it('returns fallback search results for an unrecorded query', async () => {
    const { outcome } = await runtime.tools.invoke(
      'web_search',
      { query: 'something nobody recorded', maxResults: 2 },
      ctx(0),
    );

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(JSON.stringify(outcome.output)).toContain('offline-demo');
  });
});

describe('live mode without its adapter', () => {
  it('refuses rather than quietly serving fixtures', async () => {
    const liveConfig = loadConfig({
      DEMO_MODE: 'live',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      SEARCH_PROVIDER: 'fixture',
      LOG_LEVEL: 'silent',
    });
    const live = createAgentRuntime({ config: liveConfig, logger: silentLogger });

    await expect(live.llmFor('anything')).rejects.toThrow(/M7/u);
  });
});

describe('fixtures directory', () => {
  it('resolves from the module path, not the working directory', () => {
    expect(defaultFixturesDir()).toMatch(/agentic-research-assistant\/fixtures$/u);
  });
});

function collectUrls(value: unknown, into: Set<string>): void {
  if (typeof value === 'string' && /^https?:\/\//u.test(value)) into.add(value);
  else if (Array.isArray(value)) for (const child of value) collectUrls(child, into);
  else if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) collectUrls(child, into);
  }
}
