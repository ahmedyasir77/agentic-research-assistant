import { createAgentRuntime } from './composition.ts';
import { loadConfigOrExit } from './config/env.ts';
import { createLogger } from './platform/logger.ts';

// The boot path so far: parse config once, build a logger, compose the runtime for
// the configured mode. M5 hands the result to an Express server; today it reports
// what it built so the wiring is verifiable from a terminal.
const config = loadConfigOrExit(process.env);
const logger = createLogger({ level: config.logLevel });

const runtime = createAgentRuntime({ config, logger });

logger.info(
  {
    demoMode: config.demoMode,
    modelId: runtime.modelId,
    tools: runtime.tools.names,
    port: config.port,
  },
  'agent runtime ready',
);
