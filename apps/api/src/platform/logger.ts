import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Two layers of defence against logging a credential:
 *
 *   1. secret config values are `Secret` objects that serialise as `[redacted]`
 *      (see config/secret.ts), so they cannot leak even by accident;
 *   2. these paths catch anything arriving from outside — request headers most
 *      of all, which nobody constructs by hand.
 */
const REDACTED_PATHS = [
  'authorization',
  'apiKey',
  'api_key',
  'token',
  'password',
  'secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.authorization',
  '*.apiKey',
  '*.api_key',
];

export interface LoggerOptions {
  readonly level: string;
}

/**
 * Always structured JSON — that is what the log pipeline wants, and piping through
 * `npx pino-pretty` covers the human case without another dependency.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  });
}

/** Tests assert on behaviour, not on log output. */
export const silentLogger: Logger = pino({ level: 'silent' });
