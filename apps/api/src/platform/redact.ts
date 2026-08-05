import type { JsonValue } from '@ara/shared';

/**
 * Tool arguments are chosen by a language model and then written into the trace,
 * which is displayed in a browser and shipped to logs. If a key ever finds its
 * way into a prompt, this is what stops it being published.
 */
const SENSITIVE_KEY = /(?:api[-_]?key|secret|token|password|passwd|authorization|credential)/iu;

const PLACEHOLDER = '[redacted]';

export function redactArgs(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactArgs);

  if (typeof value === 'string') return redactUrlCredentials(value);

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEY.test(key) ? PLACEHOLDER : redactArgs(child),
      ]),
    );
  }

  return value;
}

/**
 * `https://user:pass@host/` is rejected before it is ever fetched, but the
 * argument is recorded either way — so the password is stripped from the record.
 */
function redactUrlCredentials(value: string): string {
  if (!value.includes('@') || !/^https?:\/\//iu.test(value)) return value;

  try {
    const url = new URL(value);
    if (url.username === '' && url.password === '') return value;
    // Not PLACEHOLDER: the URL setter percent-encodes brackets, which would make
    // the redaction marker harder to read than the thing it replaced.
    url.username = 'redacted';
    url.password = '';
    return url.toString();
  } catch {
    return value;
  }
}
