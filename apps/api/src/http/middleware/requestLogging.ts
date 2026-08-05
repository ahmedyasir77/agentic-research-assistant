import { randomUUID } from 'node:crypto';

import { pinoHttp } from 'pino-http';
import type { RequestHandler } from 'express';

import type { Logger } from '../../platform/logger.ts';

/** Long enough for any sane correlation id, short enough not to be a log-injection vector. */
const MAX_INBOUND_ID_LENGTH = 128;

/**
 * Request logging and request identity, together, because pino-http owns `req.id`
 * and splitting them would mean two sources of truth for the same value.
 *
 * An inbound `x-request-id` is honoured so a trace started at the ingress carries
 * through, and echoed back so a user reporting a problem can quote an id that
 * appears in the logs.
 */
export function createRequestLogging(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const inbound = req.headers['x-request-id'];
      const id =
        typeof inbound === 'string' && inbound.length > 0 && inbound.length <= MAX_INBOUND_ID_LENGTH
          ? inbound
          : randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    // Health and metrics scrapes are the loudest thing in the log and the least
    // interesting; they still get logged when they fail.
    autoLogging: {
      ignore: (req) => req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics',
    },
    customLogLevel: (_req, res, error) => {
      if (error !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  });
}
