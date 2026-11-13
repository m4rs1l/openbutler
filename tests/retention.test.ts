import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ActivityLedger,
  OBSERVED_EVENT_STATES,
  TOOL_ACTION_STATES,
  type ObservedEventInput,
  type ToolActionUpdate,
} from '../src/activity-ledger.js';
import { parseRetentionDuration, selectFilesToPrune } from '../src/retention.js';
import { ScheduleRunner } from '../src/tools/schedule.js';
import {
  acknowledgeWorkerRead,
  appendWorkerNote,
  completeWorker,
  readWorkerOutbox,
  readWorkerRecord,
  writeWorkerRecord,
} from '../src/worker-records.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-retention-'));
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-retention-')) {
    throw new Error('Unsafe retention fixture path.');
  }
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const action = (requestId: string): ToolActionUpdate => ({
  requestId,
  sessionId: 'session-1',
  workspaceRoot: 'fixture',
  providerId: 'host',
  name: 'inspect',
  input: { path: 'file.txt' },
  effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
  state: 'proposed',
});

const OLD = '2020-01-01T00:00:00.000Z';
const CUTOFF = '2021-01-01T00:00:00.000Z';
const RECENT = '2022-01-01T00:00:00.000Z';

function withRawLedger(path: string, operation: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(path);
  try {
    operation(database);
  } finally {
    database.close();
  }
}

it('parses explicit retention windows', () => {
  expect(parseRetentionDuration('30d')).toBe(2_592_000_000);
  expect(parseRetentionDuration('12h')).toBe(43_200_000);
  expect(parseRetentionDuration('90m')).toBe(5_400_000);
  expect(parseRetentionDuration('2w')).toBe(1_209_600_000);
  expect(() => parseRetentionDuration('soon')).toThrow(/Invalid duration/);
  expect(() => parseRetentionDuration('0d')).toThrow(/Invalid duration/);
  expect(() => parseRetentionDuration('-1d')).toThrow(/Invalid duration/);
  expect(() => parseRetentionDuration('1y')).toThrow(/Invalid duration/);
});

it('rejects durations whose multiplication overflows safe integer milliseconds', () => {
  const largestSafeMinutes = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);
  expect(parseRetentionDuration(`${largestSafeMinutes}m`)).toBe(largestSafeMinutes * 60_000);
  expect(() => parseRetentionDuration(`${largestSafeMinutes + 1}m`)).toThrow(/Invalid duration/);
  expect(() => parseRetentionDuration(`${Number.MAX_SAFE_INTEGER}w`)).toThrow(/Invalid duration/);
  expect(() => parseRetentionDuration('999999999999999999999999999999999999d')).toThrow(/Invalid duration/);
});

it('selects only files last modified before the cutoff', () => {
  const files = [
    { id: 'old', modifiedAt: 1_000 },
    { id: 'edge', modifiedAt: 2_000 },
    { id: 'new', modifiedAt: 3_000 },
  ];
  expect(selectFilesToPrune(files, 2_000).map((file) => file.id)).toEqual(['old']);
  expect(selectFilesToPrune(files, 0)).toEqual([]);
});

it('deletes state only by a nonempty literal, case-sensitive prefix', () => {
  const ledger = new ActivityLedger(join(root, 'state.db'));
  const prefix = 'host.restart.workspace:chat:%_*[';
  const matching = [prefix, `${prefix}session-1`, `${prefix}session-2`];
  const preserved = [
    'host.restart.workspace:chat:other',
    'host.restart.workspace:chat:XYZ',
    'host.restart.workspace:Chat:%_*[session-1',
    'host.restart.workspace:root',
    `unrelated:${prefix}session-1`,
    '',
  ];
  try {
    for (const key of [...matching, ...preserved]) ledger.setState(key, key || 'empty-key');
    ledger.insertEvent({ source: 'observer', kind: 'tick', dedupeKey: 'kept-event', payload: {} });
    ledger.recordToolAction(action('kept-action'));
    expect(() => ledger.deleteStateByPrefix('')).toThrow(/prefix.*empty/i);
    for (const key of matching) expect(ledger.getState(key)).toBe(key);
    expect(ledger.deleteStateByPrefix(prefix)).toBe(matching.length);
    for (const key of matching) expect(ledger.getState(key)).toBeNull();
    for (const key of preserved) expect(ledger.getState(key)).toBe(key || 'empty-key');
    expect(ledger.deleteStateByPrefix(prefix)).toBe(0);
    expect(ledger.listEvents().map((row) => row.dedupeKey)).toEqual(['kept-event']);
    expect(ledger.listActions().map((row) => row.requestId)).toEqual(['kept-action']);
    expect(ledger.actionTransitions('kept-action')).toHaveLength(1);
  } finally {
    ledger.close();
  }
});

it('prunes only old settled events, preserving every active or retryable state and recent changes', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(OLD);
  const path = join(root, 'state.db');
  const ledger = new ActivityLedger(path);
  try {
    for (const status of OBSERVED_EVENT_STATES) {
      const { id } = ledger.insertEvent({ source: 'observer', kind: 'tick', dedupeKey: status, payload: {} });
      ledger.setEventState(id, status);
    }
    const changed = ledger.insertEvent({ source: 'observer', kind: 'tick', dedupeKey: 'recent-update', payload: {} });
    const edgeUpdated = ledger.insertEvent({ source: 'observer', kind: 'tick', dedupeKey: 'edge-update', payload: {} });
    vi.setSystemTime(CUTOFF);
    ledger.setEventState(edgeUpdated.id, 'delivered');
    const edgeReceived = ledger.insertEvent({ source: 'observer', kind: 'tick', dedupeKey: 'edge-received', payload: {} });
    ledger.setEventState(edgeReceived.id, 'delivered');
    vi.setSystemTime(RECENT);
    ledger.setEventState(changed.id, 'delivered');
    const recent = ledger.insertEvent({ source: 'observer', kind: 'tick', dedupeKey: 'recent-received', payload: {} });
    ledger.setEventState(recent.id, 'delivered');
    // Either timestamp independently protects a row, including at the boundary.
    withRawLedger(path, (database) => {
      database.prepare('UPDATE openbutler_events SET updated_at = ? WHERE event_id IN (?, ?)').run(OLD, edgeReceived.id, recent.id);
    });
    const before = ledger.listEvents();
    const preview = { events: 2, actions: 0, transitions: 0 };
    const reader = new ActivityLedger(path, { readOnly: true });
    try {
      expect(reader.previewPruneBefore(CUTOFF, 'events')).toEqual(preview);
      expect(reader.listEvents()).toEqual(before);
    } finally {
      reader.close();
    }
    expect(ledger.previewPruneBefore(CUTOFF, 'events')).toEqual(preview);
    expect(ledger.listEvents()).toEqual(before);
    expect(ledger.pruneBefore(CUTOFF, 'events')).toEqual(preview);
    expect(ledger.previewPruneBefore(CUTOFF, 'events')).toEqual({ events: 0, actions: 0, transitions: 0 });
    expect(
      ledger
        .listEvents()
        .map((row) => row.dedupeKey)
        .sort(),
    ).toEqual(['edge-received', 'edge-update', 'failed', 'interrupted', 'pending', 'processing', 'recent-received', 'recent-update']);
    for (const key of ['failed', 'interrupted']) {
      const event = ledger.findEventByDedupeKey(key)!;
      expect(ledger.retryEvent(event.id)).toBe(true);
      expect(ledger.claimEvent(event.id)?.status).toBe('processing');
    }
  } finally {
    ledger.close();
  }
});

it('prunes only terminal actions old by both timestamps and only their entire transition chains', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(OLD);
  const path = join(root, 'state.db');
  const ledger = new ActivityLedger(path);
  const terminal = ['completed', 'failed', 'cancelled', 'denied'];
  try {
    for (const state of TOOL_ACTION_STATES) {
      ledger.recordToolAction(action(state));
      if (state !== 'proposed') ledger.recordToolAction({ ...action(state), state });
    }
    for (const requestId of ['recent-update', 'edge-update']) ledger.recordToolAction(action(requestId));
    vi.setSystemTime(CUTOFF);
    ledger.recordToolAction({ ...action('edge-update'), state: 'completed' });
    ledger.recordToolAction(action('edge-created'));
    ledger.recordToolAction({ ...action('edge-created'), state: 'completed' });
    vi.setSystemTime(RECENT);
    ledger.recordToolAction({ ...action('recent-update'), state: 'completed' });
    ledger.recordToolAction(action('recent-created'));
    ledger.recordToolAction({ ...action('recent-created'), state: 'completed' });
    withRawLedger(path, (database) => {
      database
        .prepare('UPDATE openbutler_actions SET updated_at = ? WHERE request_id IN (?, ?)')
        .run(OLD, 'edge-created', 'recent-created');
      database
        .prepare('INSERT INTO openbutler_action_transitions (request_id, state, created_at) VALUES (?, ?, ?)')
        .run('completed', 'completed', RECENT);
      // An orphan's age alone is not authority to erase it.
      database
        .prepare('INSERT INTO openbutler_action_transitions (request_id, state, created_at) VALUES (?, ?, ?)')
        .run('orphan', 'started', OLD);
    });
    const before = ledger.listActions();
    const chains = new Map([...before.map((row) => row.requestId), 'orphan'].map((id) => [id, ledger.actionTransitions(id)]));
    const preview = { events: 0, actions: 4, transitions: 9 };
    const reader = new ActivityLedger(path, { readOnly: true });
    try {
      expect(reader.previewPruneBefore(CUTOFF, 'actions')).toEqual(preview);
    } finally {
      reader.close();
    }
    expect(ledger.previewPruneBefore(CUTOFF, 'actions')).toEqual(preview);
    expect(ledger.listActions()).toEqual(before);
    expect(ledger.pruneBefore(CUTOFF, 'actions')).toEqual(preview);
    expect(ledger.listActions()).toEqual(before.filter((row) => !terminal.includes(row.requestId)));
    for (const [id, chain] of chains) expect(ledger.actionTransitions(id)).toEqual(terminal.includes(id) ? [] : chain);
    expect(ledger.previewPruneBefore(CUTOFF, 'actions')).toEqual({ events: 0, actions: 0, transitions: 0 });
  } finally {
    ledger.close();
  }
});

it('preserves unread inboxes and events referenced by any retained action or usage', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(OLD);
  const ledger = new ActivityLedger(join(root, 'state.db'));
  const eventIds = new Map<string, string>();
  const insert = (dedupeKey: string, source = 'observer', payload: ObservedEventInput['payload'] = {}): string => {
    const { id } = ledger.insertEvent({ source, kind: 'message', dedupeKey, payload });
    ledger.setEventState(id, 'delivered');
    eventIds.set(dedupeKey, id);
    return id;
  };
  try {
    const activeEvent = insert('active-action');
    ledger.recordToolAction({ ...action('active'), eventId: activeEvent });
    const terminalEvent = insert('old-terminal-action');
    ledger.recordToolAction({ ...action('terminal'), eventId: terminalEvent });
    ledger.recordToolAction({ ...action('terminal'), state: 'completed' });
    const recentEvent = insert('recent-action');
    const usageEvent = insert('usage');
    for (const eventId of [usageEvent, undefined]) {
      ledger.recordUsage({
        id: eventId ? 'retained-usage' : 'unlinked-usage',
        atMs: Date.now(),
        tzOffsetMin: 0,
        sessionId: 'session-1',
        ...(eventId ? { eventId } : {}),
        runKind: 'worker',
        providerId: 'host',
        modelId: 'fixture',
        attempt: 1,
        status: 'ok',
        usageSource: 'absent',
      });
    }
    // NULL references must not prevent removal of genuinely unreferenced events.
    ledger.recordToolAction(action('unlinked'));
    insert('owner-unread', 'owner-inbox');
    const ownerIgnored = insert('owner-unread-ignored', 'owner-inbox');
    ledger.setEventState(ownerIgnored, 'ignored');
    insert('agent-unread', 'agent-inbox', { toSessionId: 'recipient' });
    const ownerRead = insert('owner-read', 'owner-inbox');
    ledger.setState(`owner-inbox:read:${ownerRead}`, OLD);
    const ownerReplied = insert('owner-replied', 'owner-inbox');
    ledger.setState(`owner-inbox:reply:${ownerReplied}`, 'reply-id');
    const agentRead = insert('agent-read', 'agent-inbox', { toSessionId: 'recipient' });
    ledger.setState(`agent-inbox:read:${agentRead}`, OLD);
    const agentIgnored = insert('agent-ignored', 'agent-inbox', { toSessionId: 'recipient' });
    ledger.setEventState(agentIgnored, 'ignored');
    insert('unreferenced');
    vi.setSystemTime(RECENT);
    ledger.recordToolAction({ ...action('recent'), eventId: recentEvent });
    const actions = ledger.listActions();
    const usage = ledger.usageRows();
    const state = ledger.stateEntries('');
    const unread = ledger.agentMessages('recipient');
    expect(unread.map((row) => row.dedupeKey)).toEqual(['agent-unread']);
    const preview = { events: 5, actions: 0, transitions: 0 };
    expect(ledger.previewPruneBefore(CUTOFF, 'events')).toEqual(preview);
    expect(ledger.pruneBefore(CUTOFF, 'events')).toEqual(preview);
    expect(
      ledger
        .listEvents()
        .map((row) => row.dedupeKey)
        .sort(),
    ).toEqual(['active-action', 'agent-unread', 'old-terminal-action', 'owner-unread', 'owner-unread-ignored', 'recent-action', 'usage']);
    expect(ledger.listActions()).toEqual(actions);
    expect(ledger.usageRows()).toEqual(usage);
    expect(ledger.stateEntries('')).toEqual(state);
    expect(ledger.agentMessages('recipient')).toEqual(unread);
    // An event becomes eligible only after its action is explicitly removed.
    expect(ledger.pruneBefore(CUTOFF, 'actions')).toEqual({ events: 0, actions: 1, transitions: 2 });
    expect(ledger.previewPruneBefore(CUTOFF, 'events')).toEqual({ events: 1, actions: 0, transitions: 0 });
    expect(ledger.pruneBefore(CUTOFF, 'events')).toEqual({ events: 1, actions: 0, transitions: 0 });
    expect(ledger.getEvent(eventIds.get('old-terminal-action')!)).toBeNull();
    expect(ledger.getEvent(usageEvent)).not.toBeNull();
    expect(ledger.usageRows()).toEqual(usage);
  } finally {
    ledger.close();
  }
});

it.each([null, 'worker error', 'Run cancelled.'])(
  'retains worker receipt history after completion (%s) and note acknowledgement',
  (error) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(OLD);
    const ledger = new ActivityLedger(join(root, 'state.db'));
    try {
      writeWorkerRecord(ledger, 'worker-1', {
        parentSessionId: 'parent-1',
        depth: 1,
        mode: 'executor',
        background: true,
        startedAt: Date.now(),
        finished: false,
      });
      appendWorkerNote(ledger, 'worker-1', 'blocked', 'blocked');
      appendWorkerNote(ledger, 'worker-1', 'question', 'question');
      const completionId = completeWorker(ledger, 'worker-1', { report: 'durable report', error })!;
      acknowledgeWorkerRead(ledger, 'parent-1', 'worker-1', 1, 2);
      const events = ledger.listEvents();
      expect(events).toHaveLength(3);
      expect(events.every((event) => event.status === 'delivered')).toBe(true);
      const record = readWorkerRecord(ledger, 'worker-1');
      const outbox = readWorkerOutbox(ledger, 'worker-1');
      expect(record?.reportedRevision).toBe(1);
      expect(outbox.read).toBe(2);
      expect(ledger.previewPruneBefore(CUTOFF, 'events')).toEqual({ events: 0, actions: 0, transitions: 0 });
      expect(ledger.pruneBefore(CUTOFF, 'events')).toEqual({ events: 0, actions: 0, transitions: 0 });
      expect(ledger.listEvents()).toEqual(events);
      for (const event of events) expect(ledger.findEventByDedupeKey(event.dedupeKey)).toEqual(event);
      expect(ledger.getEvent(completionId)?.payload.revision).toBe(record?.reportedRevision);
      expect(readWorkerRecord(ledger, 'worker-1')).toEqual(record);
      expect(readWorkerOutbox(ledger, 'worker-1')).toEqual(outbox);
    } finally {
      ledger.close();
    }
  },
);

it.each(['at', 'window'] as const)('preserves settled one-shot %s schedule history so pruning cannot re-fire work', async (adapter) => {
  vi.useFakeTimers();
  vi.setSystemTime(OLD);
  const ledger = new ActivityLedger(join(root, 'state.db'));
  const publish = vi.fn(async () => {});
  const runner = new ScheduleRunner(ledger, publish, () => {});
  try {
    const due = Date.parse(OLD);
    const event = ledger.insertEvent({
      source: `schedule:${adapter}`,
      kind: `schedule.${adapter}`,
      dedupeKey: `schedule:one-shot:${adapter === 'at' ? 'at' : 'window'}:${due}`,
      payload: { scheduleId: 'one-shot' },
    });
    ledger.setEventState(event.id, 'delivered');
    vi.setSystemTime(RECENT);
    expect(ledger.previewPruneBefore(CUTOFF, 'events')).toEqual({ events: 0, actions: 0, transitions: 0 });
    expect(ledger.pruneBefore(CUTOFF, 'events')).toEqual({ events: 0, actions: 0, transitions: 0 });
    await runner.reload([
      {
        id: 'one-shot',
        name: 'Fixture',
        enabled: true,
        workspaceRoot: root,
        originSessionId: '',
        instruction: 'Fixture only',
        trigger: adapter === 'at' ? { adapter, options: { at: OLD } } : { adapter, options: { from: OLD, to: CUTOFF } },
      },
    ]);
    expect(runner.listStatuses()).toEqual([{ id: 'one-shot', state: 'completed' }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publish).not.toHaveBeenCalled();
    expect(ledger.getEvent(event.id)?.status).toBe('delivered');
  } finally {
    runner.close();
    ledger.close();
  }
});

it('rolls back transition deletion if deleting its selected action fails', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(OLD);
  const path = join(root, 'state.db');
  const ledger = new ActivityLedger(path);
  try {
    ledger.recordToolAction(action('old'));
    ledger.recordToolAction({ ...action('old'), state: 'completed' });
    ledger.setState('protected-state', 'value');
    const event = ledger.insertEvent({ source: 'observer', kind: 'tick', dedupeKey: 'protected-event', payload: {} });
    const actions = ledger.listActions();
    const transitions = ledger.actionTransitions('old');
    const preview = { events: 0, actions: 1, transitions: 2 };
    expect(ledger.previewPruneBefore(CUTOFF, 'actions')).toEqual(preview);
    withRawLedger(path, (database) => {
      database.exec(
        "CREATE TRIGGER reject_action_prune BEFORE DELETE ON openbutler_actions BEGIN SELECT RAISE(ABORT, 'injected action prune failure'); END;",
      );
      try {
        expect(() => ledger.pruneBefore(CUTOFF, 'actions')).toThrow('injected action prune failure');
      } finally {
        database.exec('DROP TRIGGER reject_action_prune');
      }
    });
    expect(ledger.listActions()).toEqual(actions);
    expect(ledger.actionTransitions('old')).toEqual(transitions);
    expect(ledger.previewPruneBefore(CUTOFF, 'actions')).toEqual(preview);
    expect(ledger.getState('protected-state')).toBe('value');
    expect(ledger.getEvent(event.id)).not.toBeNull();
    expect(ledger.pruneBefore(CUTOFF, 'actions')).toEqual(preview);
  } finally {
    ledger.close();
  }
});

it('rolls back partially failed event deletion and trigger writes', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(OLD);
  const path = join(root, 'state.db');
  const ledger = new ActivityLedger(path);
  try {
    for (const dedupeKey of ['old-1', 'old-2']) {
      const { id } = ledger.insertEvent({ source: 'observer', kind: 'tick', dedupeKey, payload: {} });
      ledger.setEventState(id, 'delivered');
    }
    const events = ledger.listEvents();
    const preview = { events: 2, actions: 0, transitions: 0 };
    expect(ledger.previewPruneBefore(CUTOFF, 'events')).toEqual(preview);
    withRawLedger(path, (database) => {
      // RAISE(FAIL), unlike ABORT, leaves statement changes unless the outer transaction rolls back.
      database.exec(`CREATE TRIGGER reject_event_prune AFTER DELETE ON openbutler_events BEGIN
        INSERT INTO openbutler_state (key, value) VALUES ('partial-prune', 'must-roll-back');
        SELECT RAISE(FAIL, 'injected event prune failure');
      END;`);
      try {
        expect(() => ledger.pruneBefore(CUTOFF, 'events')).toThrow('injected event prune failure');
      } finally {
        database.exec('DROP TRIGGER reject_event_prune');
      }
    });
    expect(ledger.listEvents()).toEqual(events);
    expect(ledger.getState('partial-prune')).toBeNull();
    expect(ledger.previewPruneBefore(CUTOFF, 'events')).toEqual(preview);
    expect(ledger.pruneBefore(CUTOFF, 'events')).toEqual(preview);
  } finally {
    ledger.close();
  }
});

it('lists only real session files for pruning', async () => {
  vi.resetModules();
  const { createSession, listSessionFiles, saveSession } = await import('../src/session-store.js');
  const session = createSession('fixture', 'fixture', 262_144, root);
  session.entries.push({ kind: 'user', text: 'retention fixture' });
  const saved = saveSession(session);
  writeFileSync(join(root, 'sessions', 'not-a-session.json'), '{}');
  const files = listSessionFiles();
  expect(files.map((file) => file.id)).toEqual([saved.id]);
  expect(files[0]!.sizeBytes).toBeGreaterThan(0);
  expect(selectFilesToPrune(files, Date.now() + 1_000).map((file) => file.id)).toEqual([saved.id]);
});
