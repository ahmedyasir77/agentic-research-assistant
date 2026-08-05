import { AgentEventSchema, EVENT_SCHEMA_VERSION, type AgentEvent } from '@ara/shared';
import { describe, expect, it } from 'vitest';

import { RunEmitter } from './emitter.ts';

function event(seq: number): AgentEvent {
  return AgentEventSchema.parse({
    v: EVENT_SCHEMA_VERSION,
    seq,
    runId: 'run_test',
    ts: new Date(0).toISOString(),
    type: 'agent.step.started',
    step: seq,
  });
}

function collector(): {
  events: AgentEvent[];
  closes: number;
  subscriber: Parameters<RunEmitter['subscribe']>[0];
} {
  const events: AgentEvent[] = [];
  let closes = 0;
  return {
    events,
    get closes() {
      return closes;
    },
    subscriber: {
      onEvent: (received) => events.push(received),
      onClose: () => {
        closes += 1;
      },
    },
  };
}

describe('RunEmitter', () => {
  it('replays what a late subscriber missed, then streams the rest', () => {
    const emitter = new RunEmitter();
    emitter.publish(event(0));
    emitter.publish(event(1));

    const late = collector();
    emitter.subscribe(late.subscriber);
    emitter.publish(event(2));

    expect(late.events.map((e) => e.seq)).toStrictEqual([0, 1, 2]);
  });

  it('resumes after a sequence number, so a reconnect does not repeat itself', () => {
    const emitter = new RunEmitter();
    for (const seq of [0, 1, 2, 3]) emitter.publish(event(seq));

    const reconnected = collector();
    emitter.subscribe(reconnected.subscriber, 1);

    expect(reconnected.events.map((e) => e.seq)).toStrictEqual([2, 3]);
  });

  it('fans one event out to every subscriber', () => {
    const emitter = new RunEmitter();
    const first = collector();
    const second = collector();
    emitter.subscribe(first.subscriber);
    emitter.subscribe(second.subscriber);

    emitter.publish(event(0));

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
  });

  it('closes every subscriber when the run ends', () => {
    const emitter = new RunEmitter();
    const watcher = collector();
    emitter.subscribe(watcher.subscriber);

    emitter.close();

    expect(watcher.closes).toBe(1);
    expect(emitter.subscriberCount).toBe(0);
  });

  it('replays and immediately closes a subscriber that arrives after the run ended', () => {
    const emitter = new RunEmitter();
    emitter.publish(event(0));
    emitter.close();

    const afterwards = collector();
    emitter.subscribe(afterwards.subscriber);

    // The replay-then-close path: this is what lets a client fetch a finished
    // run's stream and get the whole thing without waiting for a timeout.
    expect(afterwards.events).toHaveLength(1);
    expect(afterwards.closes).toBe(1);
  });

  it('stops delivering to a subscriber that unsubscribed', () => {
    const emitter = new RunEmitter();
    const watcher = collector();
    const unsubscribe = emitter.subscribe(watcher.subscriber);

    unsubscribe();
    emitter.publish(event(0));

    expect(watcher.events).toStrictEqual([]);
  });

  it('refuses to publish after closing, because that event would be lost', () => {
    const emitter = new RunEmitter();
    emitter.close();

    expect(() => {
      emitter.publish(event(0));
    }).toThrow(/after it was closed/u);
  });
});
