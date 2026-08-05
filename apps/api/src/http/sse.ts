import type { AgentEvent } from '@ara/shared';
import type { Response } from 'express';

/**
 * A proxy that buffers a response body would hold every event until the run ends,
 * turning a live timeline into a single late dump. These headers are the ones that
 * ask nginx, Azure's ingress and the browser not to do that.
 */
const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

/** Long enough to be quiet, short enough to beat a 60s idle proxy timeout. */
const HEARTBEAT_MS = 15_000;

export interface SseStream {
  send(event: AgentEvent): void;
  close(): void;
}

/**
 * Opens an `EventSource`-compatible stream.
 *
 * Every frame carries the event's sequence number as its SSE id, so a browser that
 * reconnects sends `Last-Event-ID` and the server can replay only what was missed.
 * No `event:` field: all frames arrive on one `onmessage` handler and the client
 * discriminates on the `type` field with the shared Zod schema, which is one
 * parser instead of nine listeners.
 */
export function openSseStream(res: Response): SseStream {
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders();

  // A comment frame is a no-op to the browser and a write to the socket, which is
  // how a dead connection gets discovered while nothing is happening.
  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let closed = false;

  return {
    send: (event) => {
      if (closed) return;
      res.write(`id: ${String(event.seq)}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      res.end();
    },
  };
}

/**
 * Parses the `Last-Event-ID` header into the sequence number to resume after.
 * Anything unparseable means "start from the beginning" — a client that sends
 * nonsense gets the whole run, never a silently truncated one.
 */
export function resumeAfter(header: string | readonly string[] | undefined): number {
  const raw = typeof header === 'string' ? header : header?.[0];
  if (raw === undefined || raw.trim() === '') return -1;
  const seq = Number(raw);
  return Number.isInteger(seq) && seq >= 0 ? seq : -1;
}
