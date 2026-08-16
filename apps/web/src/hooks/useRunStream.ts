import { AgentEventSchema } from '@ara/shared';
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { ApiError, cancelRun, createRun } from '../lib/api.ts';
import { initialRunState, runReducer, type RunState } from '../lib/runReducer.ts';

export interface RunStream {
  readonly state: RunState;
  readonly start: (query: string) => void;
  readonly cancel: () => void;
  readonly reset: () => void;
}

/**
 * Owns the `EventSource` and nothing else. All the interpretation lives in
 * `runReducer`, which is a pure function — so the awkward part of this hook is
 * connection lifetime, and only connection lifetime.
 */
export function useRunStream(): RunStream {
  const [state, dispatch] = useReducer(runReducer, initialRunState);
  const sourceRef = useRef<EventSource | null>(null);
  // Read from the cancel callback, which closes over the render that created it
  // rather than the run id current when the user clicks — a ref is what stays live.
  const runIdRef = useRef<string | undefined>(undefined);

  const disconnect = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  // A component that unmounts mid-run must not leave a socket behind, and React
  // 19's StrictMode mounts twice in development specifically to catch that.
  useEffect(() => disconnect, [disconnect]);

  const start = useCallback(
    (query: string) => {
      disconnect();
      runIdRef.current = undefined;
      dispatch({ type: 'submit', query, atMs: Date.now() });

      createRun(query)
        .then(({ runId, eventsUrl }) => {
          runIdRef.current = runId;
          dispatch({ type: 'accepted', runId });
          sourceRef.current = subscribe(eventsUrl, dispatch, disconnect);
        })
        .catch((error: unknown) => {
          dispatch({ type: 'client-error', message: describe(error) });
        });
    },
    [disconnect],
  );

  // Fire-and-forget: the stream this hook is already watching is what reports the
  // outcome, via the ordinary `run.failed` event with reason `cancelled` — this
  // call just asks. A rejection here (the run finished a moment first, the
  // network dropped) is not this hook's to show; the stream either delivers the
  // real outcome or its own connection-dropped error, either of which already has
  // a path to the screen.
  const cancel = useCallback(() => {
    const runId = runIdRef.current;
    if (runId !== undefined) void cancelRun(runId);
  }, []);

  const reset = useCallback(() => {
    disconnect();
    runIdRef.current = undefined;
    dispatch({ type: 'reset' });
  }, [disconnect]);

  return { state, start, cancel, reset };
}

function subscribe(
  eventsUrl: string,
  dispatch: (action: Parameters<typeof runReducer>[1]) => void,
  disconnect: () => void,
): EventSource {
  const source = new EventSource(eventsUrl);

  source.onmessage = (message: MessageEvent<string>) => {
    const parsed = AgentEventSchema.safeParse(safeJson(message.data));
    if (!parsed.success) {
      // The contract is versioned for exactly this: an event this bundle cannot
      // read means the tab is older than the server, not that the run is broken.
      disconnect();
      dispatch({
        type: 'client-error',
        message: 'This page is older than the server it is talking to. Reload to carry on.',
      });
      return;
    }

    dispatch({ type: 'event', event: parsed.data });

    // The server closes the stream when the run ends. Closing from this side too
    // is what stops `EventSource` from dutifully reconnecting to a finished run.
    if (parsed.data.type === 'run.completed' || parsed.data.type === 'run.failed') disconnect();
  };

  source.onerror = () => {
    // `EventSource` reports both a transient drop and a dead server this way, and
    // it retries on its own — so this only becomes the user's problem once it has
    // given up, which is the CLOSED state.
    if (source.readyState === EventSource.CLOSED) {
      disconnect();
      dispatch({
        type: 'client-error',
        message:
          'The connection to the run dropped and could not be recovered. Ask again to retry.',
      });
    }
  };

  return source;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'The run could not be started. Check that the API is running and try again.';
}
