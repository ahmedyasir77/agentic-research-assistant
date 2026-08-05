import { EVENT_SCHEMA_VERSION, type AppConfig } from '@ara/shared';
import { Router } from 'express';

export interface ConfigRouteDeps {
  readonly demoMode: 'live' | 'offline';
  readonly modelId: string;
}

/**
 * The handful of facts the browser needs before it can start a run.
 *
 * Deliberately three fields: the mode, so the UI can say plainly that a run is
 * replayed rather than live; the model, so the cost estimate has something to name;
 * and the event schema version, so a tab left open across a deploy can tell the
 * user to reload instead of silently dropping events it cannot parse.
 */
export function createConfigRouter(deps: ConfigRouteDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const body: AppConfig = {
      demoMode: deps.demoMode,
      modelId: deps.modelId,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
    };
    res.json(body);
  });

  return router;
}
