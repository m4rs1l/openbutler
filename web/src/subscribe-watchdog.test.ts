import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribe } from './api.js';

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  closed = false;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string) {
    if (type === 'open') this.readyState = FakeEventSource.OPEN;
    for (const listener of this.listeners.get(type) ?? []) listener({ data: '{}' });
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

const documentListeners = new Map<string, Set<() => void>>();
let visibilityState = 'visible';
const documentStub = {
  get visibilityState() {
    return visibilityState;
  },
  addEventListener(type: string, listener: () => void) {
    const set = documentListeners.get(type) ?? new Set();
    set.add(listener);
    documentListeners.set(type, set);
  },
  removeEventListener(type: string, listener: () => void) {
    documentListeners.get(type)?.delete(listener);
  },
};

const windowStub = {
  setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(id),
  setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
  clearInterval: (id: ReturnType<typeof globalThis.setInterval>) => globalThis.clearInterval(id),
  addEventListener: () => {},
  removeEventListener: () => {},
};

const reports: Array<Record<string, unknown>> = [];
const fetchStub = vi.fn(async (_url: string, init?: { body?: string }) => {
  if (init?.body) reports.push(JSON.parse(init.body) as Record<string, unknown>);
  return { ok: true, json: async () => ({}) };
});

function startStream() {
  const stop = subscribe(
    () => {},
    () => {},
    'session-a',
  );
  const first = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  first.dispatch('open');
  first.dispatch('ping');
  return { stop, first };
}

describe('subscribe heartbeat watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    FakeEventSource.instances = [];
    documentListeners.clear();
    visibilityState = 'visible';
    reports.length = 0;
    fetchStub.mockClear();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('window', windowStub);
    vi.stubGlobal('fetch', fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('rebuilds a silently dead stream while the tab stays visible', () => {
    const { stop, first } = startStream();
    expect(FakeEventSource.instances).toHaveLength(1);

    // No ping, no error, no visibility or online event: the tab just stays
    // visible on a stream whose relay leg died without signaling.
    vi.advanceTimersByTime(60_000);

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(reports).toContainEqual(expect.objectContaining({ event: 'stream-stale', silentMs: expect.any(Number) }));

    stop();
  });

  it('leaves a stream that keeps receiving heartbeats alone', () => {
    const { stop, first } = startStream();

    for (let i = 0; i < 8; i += 1) {
      vi.advanceTimersByTime(15_000);
      first.dispatch('ping');
    }

    expect(first.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(reports).toEqual([]);

    stop();
  });

  it('does not rebuild while the tab is hidden', () => {
    const { stop, first } = startStream();
    visibilityState = 'hidden';

    vi.advanceTimersByTime(60_000);

    expect(first.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);

    stop();
  });

  it('stops the watchdog when the subscription is cleaned up', () => {
    const { stop, first } = startStream();
    stop();

    vi.advanceTimersByTime(60_000);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first.closed).toBe(true);
    expect(reports).toEqual([]);
  });
});
