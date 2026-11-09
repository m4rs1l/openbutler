/**
 * The read receipt for a delivered notification.
 *
 * The contract under test: a notification is closed because the parent holds
 * the report, not because a tool result happens to look a certain way in the
 * transcript. The delivery path declares what it handed over, the declaration
 * travels with the content, and the host turns the declaration into a durable
 * receipt when the session is saved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLedger } from '../src/activity-ledger.js';
import { DELIVERIES_KEY, deliveriesOf } from '../src/delivery.js';
import { acknowledgeSessionDeliveries, workerNeedsAttention, workerReportPending } from '../src/worker-receipts.js';
import { completeWorker, readWorkerOutbox, readWorkerRecord, writeWorkerRecord } from '../src/worker-records.js';
import type { SavedSession } from '../src/session-store.js';
import { ToolRegistry } from '../src/tools/registry.js';

let ledger: ActivityLedger;

beforeEach(() => {
  ledger = new ActivityLedger(':memory:');
});

afterEach(() => {
  ledger.close();
});

const PARENT = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';

/** A finished background worker with one completion revision. */
function finishedWorker(): void {
  writeWorkerRecord(ledger, WORKER, {
    parentSessionId: PARENT,
    depth: 1,
    mode: 'explorer',
    background: true,
    startedAt: 1_000,
    finished: true,
    completionRevision: 1,
  });
}

/** A saved session holding one tool result with the given value. */
function sessionWith(toolName: string, value: unknown): SavedSession {
  return {
    id: PARENT,
    conversation: [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName,
            output: { type: 'json', value },
          },
        ],
      },
    ],
  } as unknown as SavedSession;
}

/** A saved session holding several tool results with the given values. */
function sessionWithResults(toolName: string, values: unknown[]): SavedSession {
  return {
    id: PARENT,
    conversation: values.map((value, index) => ({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `call-${index}`,
          toolName,
          output: { type: 'json', value },
        },
      ],
    })),
  } as unknown as SavedSession;
}

const workerDelivery = { kind: 'worker', id: WORKER, revision: 1, cursor: 0 };

describe('a handover declares itself', () => {
  it('survives the size cut that replaces a long report with a preview', async () => {
    // The tool returns more than the inline limit, so the registry replaces the
    // result with a preview and a path to the full text on disk. The handover
    // has to survive that, because a receipt that disappears together with a
    // long report is a receipt that never happened.
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'big',
      description: 'A result too large to inline.',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ payload: 'y'.repeat(40_000), [DELIVERIES_KEY]: [workerDelivery] }),
    });
    const { tools } = await registry.createModelTools({
      approve: async () => true,
      approvalMode: 'full-access',
      onResult: () => {},
    });
    const tool = tools['big'] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
    const result = (await tool.execute({}, { toolCallId: 'call-1' })) as Record<string, unknown>;

    expect(result.status).toBe('truncated');
    expect(deliveriesOf(result)).toEqual([workerDelivery]);
  });

  it('is read from a tool result of any name', () => {
    // No tool name, no payload shape, no size rule: the declaration is the
    // proof. A tool that did not exist when this code was written still
    // closes its notification properly.
    finishedWorker();
    const acknowledged = acknowledgeSessionDeliveries(ledger, sessionWith('some_future_reader', { [DELIVERIES_KEY]: [workerDelivery] }));

    expect(acknowledged).toEqual([workerDelivery]);
    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBe(1);
  });

  it('closes the notification for a report that was cut for size', () => {
    // This is the shape a real long report leaves in the conversation: a
    // preview, a character count and a path, with the declaration beside it.
    finishedWorker();
    const stored = {
      status: 'truncated',
      resultPreview: 'partial report',
      originalChars: 35_885,
      spilledTo: 'C:/tmp/report.log',
      note: 'The rest is on disk.',
      [DELIVERIES_KEY]: [workerDelivery],
    };
    acknowledgeSessionDeliveries(ledger, sessionWith('inbox', stored));

    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBe(1);
  });

  it('writes the receipt only for a worker this session may read', () => {
    // The worker belongs to another parent, so the receipt is refused even
    // though the declaration is well formed.
    writeWorkerRecord(ledger, WORKER, {
      parentSessionId: '33333333-3333-4333-8333-333333333333',
      depth: 1,
      mode: 'explorer',
      background: true,
      startedAt: 1_000,
      finished: true,
      completionRevision: 1,
    });
    acknowledgeSessionDeliveries(ledger, sessionWith('inbox', { [DELIVERIES_KEY]: [workerDelivery] }));

    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBeUndefined();
  });
});

describe('a receipt that is already written is not written again', () => {
  it('does not touch the ledger on a second save of the same session', () => {
    // A session is saved more than once per turn, and a conversation only
    // grows. The handover is seen again on every later save, so the receipt
    // must not be rewritten: the durable record already is the truth.
    finishedWorker();
    const session = sessionWith('inbox', { [DELIVERIES_KEY]: [workerDelivery] });
    acknowledgeSessionDeliveries(ledger, session);
    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBe(1);

    const writes = vi.spyOn(ledger, 'setState');
    acknowledgeSessionDeliveries(ledger, session);

    expect(writes).not.toHaveBeenCalled();
    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBe(1);
  });

  it('still writes when the durable state does not cover the handover', () => {
    // The skip must never hide a receipt that is genuinely missing, or a
    // notification would stay open forever.
    finishedWorker();
    const writes = vi.spyOn(ledger, 'setState');
    acknowledgeSessionDeliveries(ledger, sessionWith('inbox', { [DELIVERIES_KEY]: [workerDelivery] }));

    expect(writes).toHaveBeenCalled();
    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBe(1);
  });
});

describe('the unread rule follows the durable receipt', () => {
  it('keeps the notification unread until the receipt is committed', () => {
    finishedWorker();
    const record = readWorkerRecord(ledger, WORKER)!;
    const notes = readWorkerOutbox(ledger, WORKER);

    // The report was handed over but the session has not been saved yet, so
    // there is no receipt and the parent still has to hear about it.
    expect(workerNeedsAttention(record, notes)).toBe(true);

    acknowledgeSessionDeliveries(ledger, sessionWith('inbox', { [DELIVERIES_KEY]: [workerDelivery] }));

    expect(workerNeedsAttention(readWorkerRecord(ledger, WORKER)!, notes)).toBe(false);
  });

  it('stays unread for a worker that was never handed over', () => {
    finishedWorker();
    expect(workerNeedsAttention(readWorkerRecord(ledger, WORKER)!, readWorkerOutbox(ledger, WORKER))).toBe(true);
  });

  it('does not depend on what the conversation looks like', () => {
    // A session that does not hold the handover at all cannot close it.
    finishedWorker();
    acknowledgeSessionDeliveries(ledger, sessionWith('inbox', { status: 'ok', items: [] }));

    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBeUndefined();
    expect(workerNeedsAttention(readWorkerRecord(ledger, WORKER)!, readWorkerOutbox(ledger, WORKER))).toBe(true);
  });
});

describe('old conversations still reconcile', () => {
  it('reads a poll result that was saved before deliveries existed', () => {
    // Conversations that are already on disk carry the old shape. They are
    // read for their own sake, so a session that was saved by an older host
    // still closes its notification.
    finishedWorker();
    const acknowledged = acknowledgeSessionDeliveries(
      ledger,
      sessionWith('subagent_poll', { session: WORKER, completionRevision: 1, notesCursor: 0 }),
      { heldWorkerIds: [WORKER] },
    );

    expect(acknowledged).toEqual([{ kind: 'worker', id: WORKER, revision: 1, cursor: 0 }]);
    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBe(1);
  });

  it('refuses an old poll result the session has no handover for', () => {
    finishedWorker();
    acknowledgeSessionDeliveries(ledger, sessionWith('subagent_poll', { session: WORKER, completionRevision: 1 }));

    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBeUndefined();
  });

  it('repairs the receipt after a crash from what is on disk', () => {
    // The host died after the conversation was written but before the
    // receipt was, so the worker is woken again. The receipt is rebuilt from
    // the saved conversation instead of the parent being asked again.
    finishedWorker();
    const saved = sessionWith('inbox', { [DELIVERIES_KEY]: [workerDelivery] });
    acknowledgeSessionDeliveries(ledger, saved, { recoveryWorkerId: WORKER });

    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBe(1);
  });

  it('takes the later poll when the conversation holds an earlier one too', () => {
    // A conversation can hold a poll from before the worker finished and one
    // from after. Only the later one carries the completion, so taking the
    // first value found would leave the notification open for good.
    finishedWorker();
    const session = sessionWithResults('subagent_poll', [
      { session: WORKER, completionRevision: 0, notesCursor: 0 },
      { session: WORKER, completionRevision: 1, notesCursor: 0 },
    ]);
    acknowledgeSessionDeliveries(ledger, session, { heldWorkerIds: [WORKER] });

    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBe(1);
  });
});

describe('a handover the parent is holding right now', () => {
  it('is not listed as unread while the report is in hand', () => {
    // The parent read the report, but the turn that holds it is not saved
    // yet, so the receipt is still to come. Listing it as unread would tell
    // the parent that a report it is already holding was never read.
    finishedWorker();
    const record = readWorkerRecord(ledger, WORKER)!;
    const notes = readWorkerOutbox(ledger, WORKER);

    expect(workerNeedsAttention(record, notes)).toBe(true);
    expect(workerNeedsAttention(record, notes, { revision: 1, notesCursor: 0 })).toBe(false);
    expect(workerReportPending(record, { revision: 1, notesCursor: 0 })).toBe(false);
  });

  it('does not silence a report that was never handed over', () => {
    // The in-flight book may only subtract a report that is really in hand.
    // A handover for another revision says nothing about this one, so it
    // must not be used to hide a report the parent never received.
    finishedWorker();
    const record = readWorkerRecord(ledger, WORKER)!;
    const notes = readWorkerOutbox(ledger, WORKER);

    expect(workerNeedsAttention(record, notes, { revision: 0, notesCursor: 0 })).toBe(true);
  });

  it('still counts notes that the parent has not read', () => {
    // The report and the notes are two cursors. A handover that covers the
    // report does not cover the notes.
    finishedWorker();
    const record = readWorkerRecord(ledger, WORKER)!;
    const notes = { notes: ['a note'], read: 0 };

    expect(workerNeedsAttention(record, notes, { revision: 1, notesCursor: 1 })).toBe(false);
    expect(workerNeedsAttention(record, notes, { revision: 1, notesCursor: 0 })).toBe(true);
  });
});

describe('a receipt that cannot be written is reported', () => {
  it('reports the failure and leaves the notification open', () => {
    // The notification stays open, so the failure has to be visible: a
    // silent failure is discovered days later, as a stuck notification with
    // no cause. The save of the session itself must not fail because of it -
    // the content is on disk, only the bookkeeping failed.
    finishedWorker();
    const failures: Array<{ id: string; error: unknown }> = [];
    vi.spyOn(ledger, 'transaction').mockImplementation(() => {
      throw new Error('ledger is locked');
    });

    const acknowledged = acknowledgeSessionDeliveries(ledger, sessionWith('inbox', { [DELIVERIES_KEY]: [workerDelivery] }), {
      onFailure: ({ delivery, error }) => failures.push({ id: delivery.id, error }),
    });

    expect(acknowledged).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.id).toBe(WORKER);
    expect(String(failures[0]?.error)).toContain('ledger is locked');
    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBeUndefined();
  });

  it('writes the receipt on the next save after a failed write', () => {
    // A failed write leaves the handover where it was: the next save sees it
    // again and writes the receipt. The failure costs a wake-up, not the
    // notification.
    finishedWorker();
    const session = sessionWith('inbox', { [DELIVERIES_KEY]: [workerDelivery] });
    vi.spyOn(ledger, 'transaction').mockImplementationOnce(() => {
      throw new Error('ledger is locked');
    });

    acknowledgeSessionDeliveries(ledger, session, { onFailure: () => {} });
    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBeUndefined();

    acknowledgeSessionDeliveries(ledger, session);
    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBe(1);
  });
});

describe('a worker handed over twice', () => {
  it('writes the completion receipt of the later handover and closes its event', () => {
    // The parent polls a running worker and reads it again once it has
    // finished. Those are two handovers of the same worker, and only the
    // second one carries the completion. Treating them as one handover threw
    // the completion receipt away, and a notification without a receipt is a
    // notification that stays open and repeats itself.
    writeWorkerRecord(ledger, WORKER, {
      parentSessionId: PARENT,
      depth: 1,
      mode: 'explorer',
      background: true,
      startedAt: 1_000,
      finished: false,
    });
    const eventId = completeWorker(ledger, WORKER, { report: 'WORKER-REPORT', error: null });

    const session = sessionWithResults('inbox', [
      { [DELIVERIES_KEY]: [{ kind: 'worker', id: WORKER, revision: 0, cursor: 0 }] },
      { [DELIVERIES_KEY]: [{ kind: 'worker', id: WORKER, revision: 1, cursor: 0 }] },
    ]);

    acknowledgeSessionDeliveries(ledger, session);

    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBe(1);
    // The event that asked for the report closes with the receipt that
    // answers it - not on the next tick.
    expect(ledger.getEvent(eventId!)?.status).toBe('delivered');
  });
});
