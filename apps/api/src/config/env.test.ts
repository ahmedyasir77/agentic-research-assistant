import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './env.ts';

const OFFLINE: NodeJS.ProcessEnv = { DEMO_MODE: 'offline', SEARCH_PROVIDER: 'fixture' };

describe('loadConfig', () => {
  it('runs with an empty environment, because the default is the offline demo', () => {
    const config = loadConfig({});
    expect(config.demoMode).toBe('offline');
    expect(config.search.provider).toBe('fixture');
    expect(config.llm.modelId).toBe('claude-opus-5');
    expect(config.budgets.maxSteps).toBe(8);
  });

  it('coerces numeric variables, which arrive from the environment as strings', () => {
    const config = loadConfig({ ...OFFLINE, PORT: '3000', MAX_STEPS: '4' });
    expect(config.port).toBe(3000);
    expect(config.budgets.maxSteps).toBe(4);
  });

  it('names the offending variable when a value is out of range', () => {
    expect(() => loadConfig({ ...OFFLINE, MAX_STEPS: '99' })).toThrowError(ConfigError);
    try {
      loadConfig({ ...OFFLINE, MAX_STEPS: '99' });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues[0]?.path).toBe('MAX_STEPS');
    }
  });

  it('refuses live mode without an api key, and says how to fix it', () => {
    try {
      loadConfig({ DEMO_MODE: 'live' });
      expect.unreachable('expected a ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const { issues } = error as ConfigError;
      expect(issues.map((i) => i.path)).toContain('ANTHROPIC_API_KEY');
      expect(issues[0]?.message).toContain('DEMO_MODE=offline');
    }
  });

  it('refuses the tavily provider without a key', () => {
    expect(() =>
      loadConfig({ DEMO_MODE: 'live', ANTHROPIC_API_KEY: 'k', SEARCH_PROVIDER: 'tavily' }),
    ).toThrowError(/TAVILY_API_KEY/);
  });

  it('refuses a live search provider in offline mode, which must never reach the network', () => {
    expect(() =>
      loadConfig({ DEMO_MODE: 'offline', SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'k' }),
    ).toThrowError(/SEARCH_PROVIDER/);
  });
});

describe('secret config values', () => {
  it('never appear in a serialised config', () => {
    const config = loadConfig({
      DEMO_MODE: 'live',
      ANTHROPIC_API_KEY: 'sk-ant-super-secret',
      SEARCH_PROVIDER: 'tavily',
      TAVILY_API_KEY: 'tvly-super-secret',
    });

    const serialised = JSON.stringify(config);
    expect(serialised).not.toContain('super-secret');
    expect(serialised).toContain('[redacted]');
    expect(`key=${String(config.llm.apiKey)}`).toBe('key=[redacted]');
  });

  it('are readable only through an explicit expose()', () => {
    const config = loadConfig({ DEMO_MODE: 'live', ANTHROPIC_API_KEY: 'sk-ant-super-secret' });
    expect(config.llm.apiKey?.expose()).toBe('sk-ant-super-secret');
  });
});
