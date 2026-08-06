import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROBLEM_CONTENT_TYPE } from '@ara/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY } from '../agent/policy.ts';
import { createAgentRuntime } from '../composition.ts';
import { loadConfig } from '../config/env.ts';
import { silentLogger } from '../platform/logger.ts';
import { RunStore } from '../runs/store.ts';
import { createApi } from './server.ts';
import { findWebBundle } from './static.ts';

/**
 * The single-container arrangement, proven against a directory shaped like a real
 * Vite build. The fixture is written rather than built because what is being tested
 * is the routing — which paths reach the bundle and which must never — not Vite.
 */
const INDEX_HTML = '<!doctype html><title>ara</title><div id="root"></div>';
const ASSET_JS = 'console.log("hashed");';

const offlineRuntime = createAgentRuntime({
  config: loadConfig({ DEMO_MODE: 'offline', SEARCH_PROVIDER: 'fixture', LOG_LEVEL: 'silent' }),
  logger: silentLogger,
});

function bundleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ara-web-'));
  writeFileSync(join(dir, 'index.html'), INDEX_HTML);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app-a1b2c3d4.js'), ASSET_JS);
  return dir;
}

function buildApi(webDir: string) {
  const { app } = createApi({
    runtime: offlineRuntime,
    policy: DEFAULT_POLICY,
    store: new RunStore(),
    logger: silentLogger,
    rateLimitPerMin: 60,
    demoMode: 'offline',
    webDir,
  });
  return app;
}

describe('findWebBundle', () => {
  it('reports no bundle when the directory holds no index.html', () => {
    // The dev arrangement: Vite serves the UI, the API serves only JSON.
    expect(findWebBundle(mkdtempSync(join(tmpdir(), 'ara-empty-')))).toBeUndefined();
  });

  it('finds a bundle by its index.html', () => {
    const dir = bundleDir();
    expect(findWebBundle(dir)).toBe(dir);
  });
});

describe('serving the web bundle', () => {
  it('serves the app shell at the root', async () => {
    const response = await request(buildApi(bundleDir())).get('/');

    expect(response.status).toBe(200);
    expect(response.type).toBe('text/html');
    expect(response.text).toContain('id="root"');
  });

  it('serves a deep link with the app shell, so a reload does not 404', async () => {
    const response = await request(buildApi(bundleDir())).get('/runs/abc123');

    expect(response.status).toBe(200);
    expect(response.text).toContain('id="root"');
  });

  it('never caches the shell, because it names the hashed assets', async () => {
    const response = await request(buildApi(bundleDir())).get('/');

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('caches a fingerprinted asset for a year', async () => {
    const response = await request(buildApi(bundleDir())).get('/assets/app-a1b2c3d4.js');

    expect(response.status).toBe(200);
    expect(response.text).toBe(ASSET_JS);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('still answers an unknown api path with a problem, not with html', async () => {
    // The failure this guards against is quiet: a fetch for a mistyped endpoint
    // would receive 200 and an HTML page, and fail at JSON.parse with no clue why.
    const response = await request(buildApi(bundleDir())).get('/api/nope');

    expect(response.status).toBe(404);
    expect(response.type).toBe(PROBLEM_CONTENT_TYPE);
  });

  it('leaves the operational endpoints alone', async () => {
    const response = await request(buildApi(bundleDir())).get('/healthz');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
