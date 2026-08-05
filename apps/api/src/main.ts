import { policyFromConfig } from './agent/policy.ts';
import { createAgentRuntime } from './composition.ts';
import { loadConfigOrExit } from './config/env.ts';
import { createApi } from './http/server.ts';
import { shutdown } from './http/shutdown.ts';
import { createLogger } from './platform/logger.ts';
import { registerDefaultMetrics } from './platform/metrics.ts';
import { RunStore } from './runs/store.ts';

// The boot path, in order: parse config, build a logger, compose the runtime for
// the configured mode, mount the API, listen. Everything below this file receives
// what it needs as arguments — this is the only place that reads the environment.
const config = loadConfigOrExit(process.env);
const logger = createLogger({ level: config.logLevel });

registerDefaultMetrics();

const runtime = createAgentRuntime({ config, logger });
const store = new RunStore();

const { app, lifecycle } = createApi({
  runtime,
  policy: policyFromConfig(config),
  store,
  logger,
  rateLimitPerMin: config.rateLimitPerMin,
});

const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      demoMode: config.demoMode,
      modelId: runtime.modelId,
      tools: runtime.tools.names,
    },
    'listening',
  );
});

// SIGTERM is how a container is asked to stop; SIGINT is Ctrl-C. Both get the same
// treatment, and a second signal is ignored rather than restarting the drain.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');

    shutdown({ server, lifecycle, store, logger }).then(
      () => {
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
