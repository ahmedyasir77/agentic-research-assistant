import type { AgentEvent } from '@ara/shared';

/**
 * jsdom has no `EventSource`, so the tests supply one.
 *
 * It is deliberately dumb: it records the URL it was opened with, hands the test a
 * way to push events, and reports whether it was closed. That last part is what
 * lets a test assert the hook cleans up rather than leaving a socket behind.
 */
export class FakeEventSource {
  // The hook reads `EventSource.CLOSED` to tell a retry from a give-up.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  static readonly instances: FakeEventSource[] = [];

  static latest(): FakeEventSource {
    const latest = FakeEventSource.instances.at(-1);
    if (latest === undefined) throw new Error('No EventSource was opened.');
    return latest;
  }

  static reset(): void {
    FakeEventSource.instances.length = 0;
  }

  readonly url: string;
  readyState = 0;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.readyState = 1;
    FakeEventSource.instances.push(this);
  }

  emit(event: AgentEvent): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
  }

  /** An event this bundle cannot parse — the schema-version mismatch path. */
  emitRaw(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** `EventSource` reports a dropped connection this way, having already retried. */
  fail(): void {
    this.readyState = 2;
    this.onerror?.(new Event('error'));
  }

  close(): void {
    this.readyState = 2;
  }
}
