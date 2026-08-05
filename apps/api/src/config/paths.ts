import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the recorded fixtures live.
 *
 * Resolved from this module's own location rather than the working directory, so
 * `pnpm demo` from the repo root and `node dist/main.js` from inside a container
 * both find the same files. `dist` mirrors `src`'s depth, so the hop count is the
 * same before and after compilation.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** apps/api/src/config → apps/api/src → apps/api → apps → repo root */
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

export function defaultFixturesDir(): string {
  return resolve(REPO_ROOT, 'fixtures');
}
