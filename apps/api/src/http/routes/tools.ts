import type { ListToolsResponse } from '@ara/shared';
import { Router } from 'express';

import type { ToolRegistry } from '../../tools/registry.ts';

/**
 * The tool list, exactly as the model receives it — same names, same descriptions,
 * same JSON Schemas, generated from the same Zod definitions.
 *
 * Worth an endpoint because it makes the central claim inspectable: what the model
 * is told about a tool and what the tool validates cannot drift, and here is the
 * proof in a browser tab.
 */
export function createToolsRouter(tools: ToolRegistry): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const body: ListToolsResponse = { tools: tools.toModelSpecs() };
    res.json(body);
  });

  return router;
}
