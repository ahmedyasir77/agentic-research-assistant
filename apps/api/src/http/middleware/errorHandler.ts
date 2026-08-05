import { PROBLEM_CONTENT_TYPE, type ProblemDetails } from '@ara/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';

import { RunCapacityError } from '../../runs/store.ts';
import { problem, ProblemError } from '../problem.ts';

/**
 * The one place an error becomes a response.
 *
 * Handlers throw and Express 5 forwards rejected promises here, which is why no
 * route in this app contains a try/catch. Anything unrecognised is a 500 with a
 * deliberately uninformative body: the detail goes to the log, where it is useful,
 * not to the client, where it is a disclosure.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  const instance = req.originalUrl;

  if (res.headersSent) {
    // Nothing can be said about an error that arrives mid-response. Hand it back
    // to Express, whose default behaviour is to destroy the socket.
    next(error);
    return;
  }

  const known = toProblemError(error);
  if (known !== undefined) {
    send(res, known.toProblemDetails(instance), known.headers);
    return;
  }

  if (error instanceof z.ZodError) {
    const details: ProblemDetails = {
      ...problem.badRequest('One or more fields were rejected.').toProblemDetails(instance),
      errors: error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    };
    send(res, details);
    return;
  }

  req.log.error({ err: error }, 'unhandled error');
  send(res, {
    type: '/problems/internal-error',
    title: 'Something went wrong on our side.',
    status: 500,
    detail: 'The request could not be completed. The failure has been logged.',
    instance,
  });
};

/** The last route: a path nothing matched is a 404 in the same shape as everything else. */
export const notFoundHandler: RequestHandler = (req, res) => {
  send(res, {
    type: '/problems/not-found',
    title: 'No such endpoint.',
    status: 404,
    detail: `${req.method} ${req.originalUrl} is not a route this API serves.`,
    instance: req.originalUrl,
  });
};

function toProblemError(error: unknown): ProblemError | undefined {
  if (error instanceof ProblemError) return error;
  if (error instanceof RunCapacityError) return problem.atCapacity(error.message);

  // body-parser signals its two failure modes with a `type` string rather than a
  // class, so this is the boundary where those become problems like any other.
  const bodyParserType = readBodyParserType(error);
  if (bodyParserType === 'entity.too.large') {
    return problem.payloadTooLarge('The request body is larger than this API accepts.');
  }
  if (bodyParserType === 'entity.parse.failed') {
    return problem.badRequest('The request body is not valid JSON.');
  }
  return undefined;
}

const BodyParserErrorSchema = z.object({ type: z.string() });

function readBodyParserType(error: unknown): string | undefined {
  const parsed = BodyParserErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.type : undefined;
}

function send(
  res: Parameters<ErrorRequestHandler>[2],
  details: ProblemDetails,
  headers: Readonly<Record<string, string>> = {},
): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.status(details.status).type(PROBLEM_CONTENT_TYPE).json(details);
}
