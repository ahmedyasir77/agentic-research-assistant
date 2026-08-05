import type { Server } from 'node:http';

import type { Logger } from '../platform/logger.ts';
import type { RunStore } from '../runs/store.ts';
import type { Lifecycle } from './lifecycle.ts';

export interface ShutdownDeps {
  readonly server: Server;
  readonly lifecycle: Lifecycle;
  readonly store: RunStore;
  readonly logger: Logger;
  /** After this, in-flight runs are abandoned rather than held onto forever. */
  readonly drainTimeoutMs?: number;
}

/**
 * Stop taking work, finish what is in hand, then close.
 *
 * The order matters. `/readyz` fails first so the load balancer stops routing new
 * requests while this instance is still able to serve the ones it has. Only then
 * do we wait for the agent runs — killing them at SIGTERM would drop a user's
 * answer seconds before it arrived, which is exactly the thing a graceful
 * shutdown exists to prevent.
 */
export async function shutdown(deps: ShutdownDeps): Promise<void> {
  const drainTimeoutMs = deps.drainTimeoutMs ?? 30_000;
  deps.lifecycle.beginDraining();

  const inFlight = deps.store.running;
  deps.logger.info({ runsInFlight: inFlight.length, drainTimeoutMs }, 'draining');

  await Promise.race([
    Promise.all(inFlight.map((record) => record.whenFinished)),
    sleep(drainTimeoutMs),
  ]);

  const abandoned = deps.store.running.length;
  if (abandoned > 0) {
    deps.logger.warn({ abandoned }, 'drain timed out with runs still going');
  }

  await closeServer(deps.server);
  deps.logger.info('closed');
}

/**
 * `close` refuses new connections and waits for open ones to finish. Idle
 * keep-alive sockets would make that wait for nothing, so they are dropped; the
 * sockets that matter are SSE streams, and those end when their run does — which
 * is why draining runs happens before this.
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeIdleConnections();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
