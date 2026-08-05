import { describe, expect, it } from 'vitest';

import { redactArgs } from './redact.ts';

describe('redactArgs', () => {
  it('leaves ordinary tool arguments untouched', () => {
    const args = { query: 'why is the sky blue', maxResults: 3, nested: { ok: true } };
    expect(redactArgs(args)).toStrictEqual(args);
  });

  it.each(['apiKey', 'api_key', 'API-KEY', 'token', 'password', 'authorization', 'client_secret'])(
    'redacts a value under the key %s',
    (key) => {
      expect(redactArgs({ [key]: 'sk-ant-real-key' })).toStrictEqual({ [key]: '[redacted]' });
    },
  );

  it('redacts nested and array members', () => {
    expect(redactArgs({ headers: [{ token: 'abc' }, { safe: 'ok' }] })).toStrictEqual({
      headers: [{ token: '[redacted]' }, { safe: 'ok' }],
    });
  });

  it('strips credentials from a url, which is recorded even though the fetch is refused', () => {
    expect(redactArgs({ url: 'https://admin:hunter2@example.com/x' })).toStrictEqual({
      url: 'https://redacted@example.com/x',
    });
  });

  it('leaves an ordinary url alone, including one with an @ in the path', () => {
    const url = 'https://example.com/users/@alice';
    expect(redactArgs({ url })).toStrictEqual({ url });
  });

  it('passes through primitives', () => {
    expect(redactArgs(42)).toBe(42);
    expect(redactArgs(null)).toBeNull();
    expect(redactArgs(true)).toBe(true);
  });
});
