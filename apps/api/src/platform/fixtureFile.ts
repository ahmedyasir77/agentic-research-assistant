import { readFile } from 'node:fs/promises';
import type { z } from 'zod';

/**
 * Fixtures are files on disk, which makes them exactly as untrusted as any other
 * input: a hand-edited JSON file with a typo should fail with the filename and the
 * field, not with `undefined is not an object` three layers away.
 */
export class FixtureError extends Error {
  constructor(path: string, detail: string) {
    super(`Fixture ${path} is unusable: ${detail}`);
    this.name = 'FixtureError';
  }
}

export async function readJsonFixture<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new FixtureError(path, error instanceof Error ? error.message : 'could not be read');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FixtureError(path, 'is not valid JSON');
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new FixtureError(path, issues);
  }

  return result.data;
}
