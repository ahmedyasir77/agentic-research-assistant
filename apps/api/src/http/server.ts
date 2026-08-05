import express, { type Express } from 'express';

import type { AgentPolicy } from '../agent/policy.ts';
import type { AgentRuntime } from '../composition.ts';
import type { Logger } from '../platform/logger.ts';
import type { RunStore } from '../runs/store.ts';
import { Lifecycle } from './lifecycle.ts';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts';
import { createRequestLogging } from './middleware/requestLogging.ts';
import { createConfigRouter } from './routes/config.ts';
import { createOperationsRouter } from './routes/operations.ts';
import { createRunsRouter } from './routes/runs.ts';
import { createToolsRouter } from './routes/tools.ts';

/**
 * A query is capped at 500 characters by the schema, so a body larger than this is
 * not a big question — it is someone testing what the endpoint accepts.
 */
const MAX_BODY_BYTES = '8kb';

export interface ServerDeps {
  readonly runtime: AgentRuntime;
  readonly policy: AgentPolicy;
  readonly store: RunStore;
  readonly logger: Logger;
  readonly rateLimitPerMin: number;
  readonly demoMode: 'live' | 'offline';
  readonly lifecycle?: Lifecycle;
}

export interface Api {
  readonly app: Express;
  readonly lifecycle: Lifecycle;
}

/**
 * Assembles the HTTP surface. Nothing here decides anything: the runtime, the
 * policy and the store all arrive built, which is why a test can stand up the
 * whole API with a scripted model and no network.
 */
export function createApi(deps: ServerDeps): Api {
  const lifecycle = deps.lifecycle ?? new Lifecycle();
  const app = express();

  // Announcing the framework and version helps nobody but a scanner.
  app.disable('x-powered-by');

  // One hop: the Container Apps ingress. Trusting further would let any client
  // forge the address the rate limiter counts against.
  app.set('trust proxy', 1);

  app.use(createRequestLogging(deps.logger));
  app.use(express.json({ limit: MAX_BODY_BYTES }));

  app.use(createOperationsRouter({ lifecycle, store: deps.store }));
  app.use(
    '/api/config',
    createConfigRouter({ demoMode: deps.demoMode, modelId: deps.runtime.modelId }),
  );
  app.use('/api/tools', createToolsRouter(deps.runtime.tools));
  app.use(
    '/api/runs',
    createRunsRouter({
      store: deps.store,
      runtime: deps.runtime,
      policy: deps.policy,
      logger: deps.logger,
      rateLimitPerMin: deps.rateLimitPerMin,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, lifecycle };
}
