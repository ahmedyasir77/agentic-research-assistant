/**
 * A string that must never be logged, serialised, or interpolated by accident.
 *
 * `toJSON` and `toString` both return a placeholder, so pino, `JSON.stringify`,
 * template literals and error dumps all render `[redacted]` without anyone having
 * to remember to redact. Reading the real value takes an explicit `.expose()`,
 * which is greppable in review — that is the whole point of the type.
 */
export interface Secret {
  readonly expose: () => string;
  readonly toJSON: () => string;
  readonly toString: () => string;
}

const PLACEHOLDER = '[redacted]';

export function secret(value: string): Secret {
  return {
    expose: () => value,
    toJSON: () => PLACEHOLDER,
    toString: () => PLACEHOLDER,
  };
}
