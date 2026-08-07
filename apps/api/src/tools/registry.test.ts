import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { HttpClient } from '../platform/httpClient.ts';
import { silentLogger } from '../platform/logger.ts';
import type { SearchProvider } from '../search/port.ts';
import { createToolRegistry } from './index.ts';
import { ToolRegistry } from './registry.ts';
import { ToolExecutionError, type Tool, type ToolContext } from './types.ts';

const ctx: ToolContext = {
  runId: 'run_1',
  step: 0,
  signal: new AbortController().signal,
  logger: silentLogger,
};

function echoTool(overrides: Partial<Tool<{ value: string }, { echoed: string }>> = {}) {
  const tool: Tool<{ value: string }, { echoed: string }> = {
    name: 'echo',
    description: 'Echo a value back.',
    inputSchema: z.object({ value: z.string().min(1) }),
    outputSchema: z.object({ echoed: z.string() }),
    timeoutMs: 50,
    evidence: 'none',
    execute: ({ value }) => Promise.resolve({ echoed: value }),
    ...overrides,
  };
  return tool;
}

describe('ToolRegistry.invoke never throws', () => {
  it('returns ok with the validated output on success', async () => {
    const registry = new ToolRegistry([echoTool()]);
    const { outcome } = await registry.invoke('echo', { value: 'hi' }, ctx);

    expect(outcome).toStrictEqual({ status: 'ok', output: { echoed: 'hi' } });
  });

  it('reports an unknown tool and lists the real ones, so the model can correct itself', async () => {
    const registry = new ToolRegistry([echoTool()]);
    const { outcome } = await registry.invoke('summon_daemon', {}, ctx);

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error.kind).toBe('unknown_tool');
    expect(outcome.error.message).toContain('echo');
  });

  it('reports invalid arguments with the offending field named', async () => {
    const registry = new ToolRegistry([echoTool()]);
    const { outcome } = await registry.invoke('echo', { value: 42 }, ctx);

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error.kind).toBe('invalid_arguments');
    expect(outcome.error.message).toMatch(/value/u);
  });

  it('validates arguments before the tool runs, so a bad call has no side effect', async () => {
    const execute = vi.fn(() => Promise.resolve({ echoed: 'never' }));
    const registry = new ToolRegistry([echoTool({ execute })]);

    await registry.invoke('echo', { wrong: true }, ctx);
    expect(execute).not.toHaveBeenCalled();
  });

  it('turns a tool timeout into a timeout outcome', async () => {
    const registry = new ToolRegistry([
      echoTool({ timeoutMs: 5, execute: () => new Promise(() => undefined) }),
    ]);
    const { outcome } = await registry.invoke('echo', { value: 'hi' }, ctx);

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error.kind).toBe('timeout');
    expect(outcome.error.message).toContain('5ms');
  });

  it('passes a ToolExecutionError message through, because it is written for the model', async () => {
    const registry = new ToolRegistry([
      echoTool({
        execute: () => Promise.reject(new ToolExecutionError('That URL is not reachable.')),
      }),
    ]);
    const { outcome } = await registry.invoke('echo', { value: 'hi' }, ctx);

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error.kind).toBe('execution_failed');
    expect(outcome.error.message).toBe('That URL is not reachable.');
  });

  it('does not leak the detail of an unexpected crash to the model', async () => {
    const registry = new ToolRegistry([
      echoTool({
        execute: () =>
          Promise.reject(new TypeError('cannot read properties of undefined (db.pool)')),
      }),
    ]);
    const { outcome } = await registry.invoke('echo', { value: 'hi' }, ctx);

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error.kind).toBe('execution_failed');
    expect(outcome.error.message).toBe('echo failed unexpectedly.');
    expect(outcome.error.message).not.toContain('db.pool');
  });

  it('catches a tool that breaks its own output contract', async () => {
    const registry = new ToolRegistry([
      echoTool({
        // The one deliberate cast in the codebase: there is no type-safe way to
        // write a tool that breaks its own output contract, which is the thing
        // under test.
        execute: () => Promise.resolve({ wrong: 'shape' } as unknown as { echoed: string }),
      }),
    ]);
    const { outcome } = await registry.invoke('echo', { value: 'hi' }, ctx);

    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error.kind).toBe('invalid_output');
  });

  it('measures how long the call took', async () => {
    let clock = 1_000;
    const registry = new ToolRegistry([echoTool()], {
      now: () => {
        clock += 25;
        return clock;
      },
    });
    const { durationMs } = await registry.invoke('echo', { value: 'hi' }, ctx);
    expect(durationMs).toBe(25);
  });
});

describe('ToolRegistry construction', () => {
  it('refuses duplicate tool names, because the name is the address', () => {
    expect(() => new ToolRegistry([echoTool(), echoTool()])).toThrow(/Duplicate tool name/u);
  });
});

/**
 * The contract test from the plan: whatever tools are registered, each one must
 * describe itself to the model in valid JSON Schema and accept a sample input
 * through that same schema. A tool that cannot do both is broken before it runs.
 */
describe('tool contract', () => {
  const stubSearch: SearchProvider = { name: 'stub', search: () => Promise.resolve([]) };
  const stubHttp: HttpClient = {
    get: () =>
      Promise.resolve({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: Readable.from(['ok']),
      }),
  };
  const registry = createToolRegistry({
    searchProvider: stubSearch,
    http: {
      http: stubHttp,
      resolveDns: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
    },
  });

  const samples: Readonly<Record<string, unknown>> = {
    web_search: { query: 'rayleigh scattering', maxResults: 3 },
    http_get: { url: 'https://example.com/optics' },
    calculator: { expression: '2 + 2' },
    finish: {
      answer: 'Because of Rayleigh scattering. [1]',
      citations: [{ id: 1, url: 'https://example.com/optics', title: 'Optics' }],
    },
  };

  it('registers exactly the four tools the agent is documented to have', () => {
    expect([...registry.names].sort()).toStrictEqual([
      'calculator',
      'finish',
      'http_get',
      'web_search',
    ]);
  });

  it.each(Object.keys(samples))('%s produces a usable JSON Schema', (name) => {
    const spec = registry.toModelSpecs().find((candidate) => candidate.name === name);
    expect(spec).toBeDefined();
    if (spec === undefined) return;

    expect(spec.description.length).toBeGreaterThan(20);
    expect(spec.timeoutMs).toBeGreaterThan(0);
    // Anthropic's tool contract requires an object schema at the root.
    expect(spec.inputSchema).toMatchObject({ type: 'object' });
    expect(JSON.parse(JSON.stringify(spec.inputSchema))).toStrictEqual(spec.inputSchema);
  });

  it.each(Object.entries(samples))('%s round-trips a sample input', async (name, sample) => {
    const { outcome } = await registry.invoke(name, sample, ctx);
    if (outcome.status === 'error') {
      expect(outcome.error.kind).not.toBe('invalid_arguments');
      expect(outcome.error.kind).not.toBe('unknown_tool');
    }
  });
});
