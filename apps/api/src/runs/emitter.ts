import type { AgentEvent } from '@ara/shared';

/**
 * What a subscriber needs: the events, and the news that there will be no more.
 * Two callbacks rather than an EventEmitter because the close signal is not
 * optional — an SSE response that is never told the run ended is never closed.
 */
export interface RunSubscriber {
  onEvent(event: AgentEvent): void;
  onClose(): void;
}

/**
 * One run's events, buffered and fanned out.
 *
 * The buffer is what makes POST-then-subscribe work: the run starts immediately
 * and the browser attaches a moment later, so a subscriber is replayed everything
 * it missed before it starts receiving live events. The same mechanism lets a
 * client that dropped its connection re-attach with `Last-Event-ID` and carry on
 * from the sequence number it last saw.
 */
export class RunEmitter {
  readonly #events: AgentEvent[] = [];
  readonly #subscribers = new Set<RunSubscriber>();
  #closed = false;

  get events(): readonly AgentEvent[] {
    return this.#events;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  publish(event: AgentEvent): void {
    if (this.#closed) {
      throw new Error(`Run ${event.runId} published an event after it was closed.`);
    }
    this.#events.push(event);
    for (const subscriber of this.#subscribers) subscriber.onEvent(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of this.#subscribers) subscriber.onClose();
    this.#subscribers.clear();
  }

  /**
   * Replays the buffer, then streams. `sinceSeq` is exclusive: pass the last
   * sequence number you saw and you get everything after it.
   *
   * Returns the unsubscribe function — the SSE route calls it when the client
   * disconnects, which is what stops a closed socket from being written to.
   */
  subscribe(subscriber: RunSubscriber, sinceSeq = -1): () => void {
    for (const event of this.#events) {
      if (event.seq > sinceSeq) subscriber.onEvent(event);
    }

    if (this.#closed) {
      subscriber.onClose();
      return () => undefined;
    }

    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }
}
