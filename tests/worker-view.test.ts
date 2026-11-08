import { describe, expect, it } from 'vitest';
import { isSubagentToolEntry, lastWorkerEntryIndex, workerSessionIdOf, workerViewAttach } from '../src/worker-view.js';
import type { SessionEntry } from '../src/session-store.js';

type ToolEntry = Extract<SessionEntry, { kind: 'tool' }>;

const subagent = (over: Record<string, unknown> = {}): ToolEntry =>
  ({
    kind: 'tool',
    tool: 'host:subagent',
    input: { task: 'explore', mode: 'explorer', background: false, context: { paths: [] } },
    result: '',
    ...over,
  }) as ToolEntry;

const userEntry = (text: string): SessionEntry => ({ kind: 'user', text, images: [] }) as SessionEntry;
const assistantEntry = (text: string): SessionEntry => ({ kind: 'assistant', text }) as SessionEntry;

describe('isSubagentToolEntry', () => {
  it('recognizes rows by the namespaced tool name', () => {
    expect(isSubagentToolEntry(subagent())).toBe(true);
    expect(isSubagentToolEntry(subagent({ tool: 'host:file_read' }))).toBe(false);
    expect(isSubagentToolEntry(subagent({ tool: 'mcp:explorer-search' }))).toBe(false);
  });

  it('falls back to the display-command prefix for stored rows without a tool field', () => {
    expect(isSubagentToolEntry({ kind: 'tool', result: 'x', command: 'subagent executor · do it' } as ToolEntry)).toBe(true);
    expect(isSubagentToolEntry({ kind: 'tool', result: 'x', command: 'subagent explorer' } as ToolEntry)).toBe(true);
    expect(isSubagentToolEntry({ kind: 'tool', result: 'x', command: 'subagent' } as ToolEntry)).toBe(false);
    expect(isSubagentToolEntry({ kind: 'tool', result: 'x', command: 'subagent_poll abcdef12' } as ToolEntry)).toBe(false);
    expect(isSubagentToolEntry({ kind: 'tool', result: 'x', command: 'subagent_stop abcdef12' } as ToolEntry)).toBe(false);
    expect(isSubagentToolEntry({ kind: 'tool', result: 'x', command: 'file_read src/a.ts' } as ToolEntry)).toBe(false);
  });

  it('ignores non-tool rows', () => {
    expect(isSubagentToolEntry(userEntry('subagent explorer'))).toBe(false);
    expect(isSubagentToolEntry(assistantEntry('subagent explorer'))).toBe(false);
    expect(isSubagentToolEntry(undefined)).toBe(false);
  });
});

describe('workerSessionIdOf', () => {
  it('prefers the machine-readable field over the result body', () => {
    expect(workerSessionIdOf(subagent({ session: 'field-1', result: JSON.stringify({ session: 'json-2' }) }))).toBe('field-1');
  });

  it('recovers the id from legacy JSON results', () => {
    expect(workerSessionIdOf(subagent({ result: JSON.stringify({ status: 'completed', session: 'json-3', report: 'ok' }) }))).toBe(
      'json-3',
    );
    expect(workerSessionIdOf(subagent({ result: '{"session": 12345}' }))).toBeNull();
    expect(workerSessionIdOf(subagent({ result: 'not json at all' }))).toBeNull();
    expect(workerSessionIdOf(subagent({ result: '["array"]' }))).toBeNull();
  });

  it('returns null when there is no id on a settled entry', () => {
    expect(workerSessionIdOf(subagent({ result: 'Trace complete.' }))).toBeNull();
    expect(workerSessionIdOf(subagent({ result: '' }))).toBeNull();
  });
});

describe('workerViewAttach', () => {
  it('attaches to the blocked-on worker while running or preparing, never guesses an id', () => {
    expect(workerViewAttach(subagent({ running: true }), 'parent-1')).toEqual({ runningWorkerOf: 'parent-1' });
    expect(workerViewAttach(subagent({ preparing: true }), 'parent-1')).toEqual({ runningWorkerOf: 'parent-1' });
    expect(workerViewAttach(subagent({ running: true, session: 'ignored-while-running' }), 'parent-1')).toEqual({
      runningWorkerOf: 'parent-1',
    });
  });

  it('attaches to the settled worker by its session id', () => {
    expect(workerViewAttach(subagent({ session: 'done-1' }), 'parent-1')).toEqual({ workerSessionId: 'done-1' });
    expect(workerViewAttach(subagent({ result: JSON.stringify({ session: 'done-2' }) }), 'parent-1')).toEqual({
      workerSessionId: 'done-2',
    });
  });

  it('refuses to invent an attach target for a settled call with no recorded id', () => {
    expect(workerViewAttach(subagent({ result: 'done, no id' }), 'parent-1')).toBeNull();
  });
});

describe('lastWorkerEntryIndex', () => {
  it('is null when no worker call exists', () => {
    expect(lastWorkerEntryIndex([])).toBeNull();
    expect(lastWorkerEntryIndex([userEntry('hi'), assistantEntry('hello')])).toBeNull();
  });

  it('returns the newest worker index', () => {
    const entries: SessionEntry[] = [userEntry('hi'), subagent({ session: 'a' }), assistantEntry('middle'), subagent({ running: true })];
    expect(lastWorkerEntryIndex(entries)).toBe(3);
    expect(lastWorkerEntryIndex(entries.slice(0, 3))).toBe(1);
  });
});
