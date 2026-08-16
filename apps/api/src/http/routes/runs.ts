import {
  CreateRunRequestSchema,
  type CancelRunResponse,
  type CreateRunResponse,
} from '@ara/shared';
import { Router, type RequestHandler } from 'express';

import { startRun, type StartRunDeps } from '../../runs/startRun.ts';
import { createRateLimiter } from '../middleware/rateLimit.ts';
import { problem } from '../problem.ts';
import { openSseStream, resumeAfter } from '../sse.ts';

export interface RunsRouterDeps extends StartRunDeps {
  readonly rateLimitPerMin: number;
}

/**
 * Create a run, then subscribe to it — rather than streaming the run out of the
 * POST itself.
 *
 * It costs an extra round trip and buys three things: the browser can use
 * `EventSource`, which reconnects on its own; a dropped connection can re-attach
 * to a run that never stopped; and the run remains fetchable as a trace after it
 * ends, so the demo can show the receipts.
 */
export function createRunsRouter(deps: RunsRouterDeps): Router {
  const router = Router();
  const rateLimit = createRateLimiter({ limitPerMinute: deps.rateLimitPerMin });

  router.post('/', rateLimit, createRun(deps));
  router.get('/:runId', readTrace(deps));
  router.get('/:runId/events', streamEvents(deps));
  router.post('/:runId/cancel', cancelRun(deps));

  return router;
}

/** `202`, not `201`: the run is accepted and under way, not finished. */
function createRun(deps: RunsRouterDeps): RequestHandler<Record<string, string>, unknown, unknown> {
  return async (req, res) => {
    // Throwing a ZodError here is the validation path — the central error handler
    // turns it into problem+json with the offending fields named.
    const { query } = CreateRunRequestSchema.parse(req.body);
    const record = await startRun(query, deps);

    const body: CreateRunResponse = {
      runId: record.runId,
      eventsUrl: `/api/runs/${record.runId}/events`,
    };
    res.status(202).json(body);
  };
}

function readTrace(deps: RunsRouterDeps): RequestHandler<{ runId: string }> {
  return (req, res) => {
    const record = deps.store.get(req.params.runId);
    if (record === undefined) throw notFound(req.params.runId);

    if (record.trace !== undefined) {
      res.json(record.trace);
      return;
    }
    if (record.status === 'running') {
      throw problem.stillRunning(
        `Run ${req.params.runId} is still going. Subscribe to /api/runs/${req.params.runId}/events to watch it.`,
      );
    }
    throw problem.noTrace(`Run ${req.params.runId} stopped without producing a trace.`);
  };
}

/**
 * `202`, not `204`: cancelling is a request, not an instant fact. The run still
 * ends through the `run.failed` event a subscriber is already watching — this
 * route exists so a client with no open stream (or one that gave up on it) has a
 * way to ask at all.
 */
function cancelRun(deps: RunsRouterDeps): RequestHandler<{ runId: string }> {
  return (req, res) => {
    const record = deps.store.get(req.params.runId);
    if (record === undefined) throw notFound(req.params.runId);

    if (record.status !== 'running') {
      throw problem.alreadyFinished(
        `Run ${req.params.runId} has already finished; there is nothing to cancel.`,
      );
    }

    record.cancel();
    const body: CancelRunResponse = { runId: record.runId };
    res.status(202).json(body);
  };
}

function streamEvents(deps: RunsRouterDeps): RequestHandler<{ runId: string }> {
  return (req, res) => {
    const record = deps.store.get(req.params.runId);
    if (record === undefined) throw notFound(req.params.runId);

    const stream = openSseStream(res);
    const unsubscribe = record.emitter.subscribe(
      {
        onEvent: (event) => {
          stream.send(event);
        },
        onClose: () => {
          stream.close();
        },
      },
      resumeAfter(req.headers['last-event-id']),
    );

    // A closed tab is the ordinary way this ends. Unsubscribing here is what stops
    // a finished run's emitter from holding a reference to a dead socket.
    req.on('close', () => {
      unsubscribe();
      stream.close();
    });
  };
}

function notFound(runId: string): Error {
  return problem.notFound(
    `Run ${runId} is not in this instance's memory. Runs are held for a short time and are not shared between instances.`,
  );
}
