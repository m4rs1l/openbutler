import { describe, expect, it, vi } from 'vitest';
import { ActivityLedger } from '../src/activity-ledger.js';
import { createWorkerService } from '../src/host/worker-service.js';

const PARENT_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A notification the parent never opens used to re-arm its own wake forever:
 * every retry delivered the identical notice text, so one unread notification
 * turned into permanent noise - the same empty reminder every few minutes.
 *
 * The event must reach a terminal state instead: the reminder loop ends, the
 * event stops being pending, and the notification itself stays in the inbox.
 */
describe('worker inbox reminder ceiling', () => {
  function buildService(ledger: ActivityLedger, signalStillNeeded: () => boolean) {
    const sent: string[] = [];
    const controller = {
      automaticWakeHeld: false,
      sendEvent: vi.fn(async (event: { text: string }) => {
        sent.push(event.text);
      }),
      flushSave: vi.fn(async () => {}),
      takeEventRunResult: vi.fn(() => undefined),
      getLastRunError: vi.fn(() => null),
      getSnapshot: vi.fn(() => ({ session: { id: PARENT_ID } })),
    };
    const service = createWorkerService({
      ledger,
      workers: new Map(),
      options: { log: () => {} },
      scheduleEventRetry: () => {},
      pumpEvents: () => {},
      inFlightWorkerDeliveries: new Map(),
      findSessionController: (id: string) => (id === PARENT_ID ? (controller as never) : undefined),
      findLiveSessionById: () => null,
      getCustodianWorkspace: async () => ({}) as never,
      getWorkspace: async () => ({}) as never,
      custodianWorkspace: () => null,
      readWorkerRecord: () => null,
      writeWorkerRecord: () => {},
      createPrivateSession: async () => ({}) as never,
      signalStillNeeded,
      workspaces: new Map(),
      isClosing: () => false,
      acknowledgeSavedWorkerReads: () => {},
      redactSensitiveText: (text: string) => text,
      inboxReminderMs: 5 * 60_000,
    });
    return { service, sent };
  }

  it('closes the event after the reminder ceiling instead of waking the parent forever', async () => {
    const ledger = new ActivityLedger(':memory:');
    const inserted = ledger.insertEvent({
      source: 'worker',
      kind: 'worker.finished',
      dedupeKey: 'worker.finished:child-1',
      payload: { parentSessionId: PARENT_ID, workerId: 'child-1' },
    });
    // The parent never opens the notification: the signal is always still needed.
    const { service, sent } = buildService(ledger, () => true);

    // Each pass is what the host does when the retry timer fires: only a
    // pending event is re-processed, so the loop ends on its own once the
    // event reaches a terminal state.
    for (let pass = 0; pass < 20; pass += 1) {
      const event = ledger.getEvent(inserted.id)!;
      if (event.status !== 'pending') break;
      await service.processWorkerEvent(event);
    }

    const event = ledger.getEvent(inserted.id)!;
    // The event reached a terminal state, so the host stops re-processing it.
    expect(event.status).toBe('ignored');
    expect(event.error).toContain('did not open the notification');
    // The wake was not delivered forever: the ceiling bounds the reminders.
    expect(sent.length).toBeLessThanOrEqual(12);
    // The reminder count is released, so a later event starts from zero.
    expect(ledger.getState(`worker:remind:${inserted.id}`)).toBe('0');
  });

  it('stops reminding an event the parent already opened', async () => {
    const ledger = new ActivityLedger(':memory:');
    const inserted = ledger.insertEvent({
      source: 'worker',
      kind: 'worker.finished',
      dedupeKey: 'worker.finished:child-2',
      payload: { parentSessionId: PARENT_ID, workerId: 'child-2' },
    });
    let needed = true;
    const { service } = buildService(ledger, () => needed);

    // The parent opens the notification: the signal is no longer needed.
    await service.processWorkerEvent(ledger.getEvent(inserted.id)!);
    needed = false;
    await service.processWorkerEvent(ledger.getEvent(inserted.id)!);

    expect(ledger.getEvent(inserted.id)!.status).toBe('delivered');
  });
});
