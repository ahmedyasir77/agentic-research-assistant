import type { GuardedGetDeps } from '../platform/guardedGet.ts';
import type { SearchProvider } from '../search/port.ts';
import { createCalculatorTool } from './calculator.ts';
import { createFinishTool } from './finish.ts';
import { createHttpGetTool } from './httpGet.ts';
import { ToolRegistry, type ToolRegistryOptions } from './registry.ts';
import { createWebSearchTool } from './webSearch.ts';

export interface ToolDeps {
  readonly searchProvider: SearchProvider;
  readonly http: GuardedGetDeps;
  readonly registry?: ToolRegistryOptions;
}

/**
 * The agent's entire capability surface, in one list.
 *
 * Adding a tool is this file plus one new file: implement `Tool`, add it here.
 * Nothing in the agent loop, the prompt, or the API changes — the loop reads the
 * registry, and the model is told about the new tool automatically.
 */
export function createToolRegistry(deps: ToolDeps): ToolRegistry {
  return new ToolRegistry(
    [
      createWebSearchTool({ provider: deps.searchProvider }),
      createHttpGetTool(deps.http),
      createCalculatorTool(),
      createFinishTool(),
    ],
    deps.registry ?? {},
  );
}
