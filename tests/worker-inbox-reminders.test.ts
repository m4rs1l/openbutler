import { describe, expect, it, vi } from 'vitest';
import { ActivityLedger } from '../src/activity-ledger.js';
import { createWorkerService } from '../src/host/worker-service.js';

const PARENT_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A notification wakes the parent until the parent has really read it.
 *
 * The wake loop is not bounded by a counter: what ends it is the durable
 * receipt. While the receipt is outstanding the event stays pending and the
 * host keeps waking the parent, because an unread notification that stops
 * reminding is a notification that is lost. When the receipt lands the event
 * is delivered for good and the parent is never woken about it again.
 */
describe('worker notification wake lifecycle', () => {
  function buildService(
    ledger: ActivityLedger,
    options: {
      receiptOutstanding: () => boolean;
      signalStillNeeded?: () => boolean;
      acknowledgeSavedWorkerReads?: () => void;
    },
  ) {
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
      signalStillNeeded: options.signalStillNeeded ?? (() => true),
      receiptOutstanding: options.receiptOutstanding,
      workspaces: new Map(),
      isClosing: () => false,
      acknowledgeSavedWorkerReads: options.acknowledgeSavedWorkerReads ?? (() => {}),
      redactSensitiveText: (text: string) => text,
      inboxReminderMs: 5 * 60_000,
    });
    return { service, sent };
  }

  it('keeps waking the parent while the receipt is outstanding', async () => {
    const ledger = new ActivityLedger(':memory:');
    const inserted = ledger.insertEvent({
      source: 'worker',
      kind: 'worker.finished',
      dedupeKey: 'worker.finished:child-1',
      payload: { parentSessionId: PARENT_ID, workerId: 'child-1' },
    });
    // The parent has not read the report, so no receipt exists.
    const { service, sent } = buildService(ledger, { receiptOutstanding: () => true });

    // Every pass is what the host does when the retry timer fires. The event
    // stays pending for as long as the notification is unread, so the loop is
    // bounded by the read and not by a counter.
    for (let pass = 0; pass < 5; pass += 1) {
      const event = ledger.getEvent(inserted.id)!;
      if (event.status !== 'pending') break;
      await service.processWorkerEvent(event);
    }

    const event = ledger.getEvent(inserted.id)!;
    expect(event.status).toBe('pending');
    expect(sent.length).toBe(5);
  });

  it('stops waking the parent once the receipt lands', async () => {
    const ledger = new ActivityLedger(':memory:');
    const inserted = ledger.insertEvent({
      source: 'worker',
      kind: 'worker.finished',
      dedupeKey: 'worker.finished:child-2',
      payload: { parentSessionId: PARENT_ID, workerId: 'child-2' },
    });
    let outstanding = true;
    const { service, sent } = buildService(ledger, { receiptOutstanding: () => outstanding });

    await service.processWorkerEvent(ledger.getEvent(inserted.id)!);
    expect(ledger.getEvent(inserted.id)!.status).toBe('pending');

    // The parent read the report and the receipt was written.
    outstanding = false;
    await service.processWorkerEvent(ledger.getEvent(inserted.id)!);

    expect(ledger.getEvent(inserted.id)!.status).toBe('delivered');
    // The delivery that closed the event is the last wake about it.
    expect(sent.length).toBe(1);
  });
});
