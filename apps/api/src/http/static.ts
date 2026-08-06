import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import express, { Router } from 'express';

import { REPO_ROOT } from '../config/paths.ts';

/**
 * In production this one process serves both the API and the React bundle.
 *
 * That is a deliberate simplification, not an oversight: one container is the
 * smallest thing that can be deployed, demoed and reasoned about, and the UI is a
 * few hundred kilobytes. A real product would put the bundle on a CDN and leave
 * this process serving JSON. See ADR-031.
 */
const ONE_YEAR_SECONDS = 31_536_000;

/**
 * Locates the built bundle, or reports that there isn't one.
 *
 * Absence is normal rather than exceptional: in development Vite serves the UI on
 * its own port and the API has no bundle to hand out, so the caller mounts nothing
 * and the API keeps working exactly as it does in every test.
 */
export function findWebBundle(configuredDir: string | undefined): string | undefined {
  const dir = configuredDir ?? resolve(REPO_ROOT, 'apps', 'web', 'dist');
  return existsSync(join(dir, 'index.html')) ? dir : undefined;
}

/**
 * Serves the bundle, with a single-page fallback so a deep link works on a cold
 * load. Mounted after the API routers, so a path the API owns can never be
 * answered with HTML.
 */
export function createWebRouter(webDir: string): Router {
  const router = Router();
  const indexHtml = join(webDir, 'index.html');

  router.use(
    express.static(webDir, {
      // The fallback below owns `/`, so static handling must not answer it first
      // and skip the no-store header that index.html needs.
      index: false,
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', cacheControlFor(filePath));
      },
    }),
  );

  // `{*path}` is Express 5's named wildcard: it matches `/` and everything below
  // it. Unmatched `/api` paths are excluded so they still get a problem+json 404
  // from the error handler rather than an HTML page a fetch cannot parse.
  router.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(indexHtml);
  });

  return router;
}

/**
 * Vite fingerprints every asset filename, so those bytes can never go stale and are
 * cached for a year. `index.html` keeps the fingerprints, so caching it is how a
 * deploy goes unnoticed by a browser that has already been here.
 */
function cacheControlFor(filePath: string): string {
  return filePath.endsWith('.html')
    ? 'no-store'
    : `public, max-age=${String(ONE_YEAR_SECONDS)}, immutable`;
}
