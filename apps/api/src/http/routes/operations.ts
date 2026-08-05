import { Router } from 'express';

import { metricsRegistry } from '../../platform/metrics.ts';
import type { Lifecycle } from '../lifecycle.ts';
import type { RunStore } from '../../runs/store.ts';

export interface OperationsDeps {
  readonly lifecycle: Lifecycle;
  readonly store: RunStore;
}

/**
 * The endpoints an operator polls rather than a user visits: liveness, readiness
 * and the Prometheus exposition.
 */
export function createOperationsRouter(deps: OperationsDeps): Router {
  const router = Router();

  // Liveness answers "is this process wedged". It deliberately checks nothing
  // else: a dependency being down is not a reason to have the process restarted.
  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', (_req, res) => {
    if (!deps.lifecycle.accepting) {
      res.status(503).json({ status: 'draining', runsInFlight: deps.store.running.length });
      return;
    }
    res.json({ status: 'ready', runsInFlight: deps.store.running.length });
  });

  router.get('/metrics', async (_req, res) => {
    res.type(metricsRegistry.contentType).send(await metricsRegistry.metrics());
  });

  return router;
}
