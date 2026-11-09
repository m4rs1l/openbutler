/**
 * The read receipt for a delivered notification.
 *
 * The contract under test: a notification is closed because the parent holds
 * the report, not because a tool result happens to look a certain way in the
 * transcript. The delivery path declares what it handed over, the declaration
 * travels with the content, and the host turns the declaration into a durable
 * receipt when the session is saved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityLedger } from '../src/activity-ledger.js';
import { DELIVERIES_KEY, deliveriesOf } from '../src/delivery.js';
import { acknowledgeSessionDeliveries, workerHasUnread } from '../src/worker-receipts.js';
import { readWorkerOutbox, readWorkerRecord, writeWorkerRecord } from '../src/worker-records.js';
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

describe('the unread rule follows the durable receipt', () => {
  it('keeps the notification unread until the receipt is committed', () => {
    finishedWorker();
    const record = readWorkerRecord(ledger, WORKER)!;
    const notes = readWorkerOutbox(ledger, WORKER);

    // The report was handed over but the session has not been saved yet, so
    // there is no receipt and the parent still has to hear about it.
    expect(workerHasUnread(record, notes)).toBe(true);

    acknowledgeSessionDeliveries(ledger, sessionWith('inbox', { [DELIVERIES_KEY]: [workerDelivery] }));

    expect(workerHasUnread(readWorkerRecord(ledger, WORKER)!, notes)).toBe(false);
  });

  it('stays unread for a worker that was never handed over', () => {
    finishedWorker();
    expect(workerHasUnread(readWorkerRecord(ledger, WORKER)!, readWorkerOutbox(ledger, WORKER))).toBe(true);
  });

  it('does not depend on what the conversation looks like', () => {
    // A session that does not hold the handover at all cannot close it.
    finishedWorker();
    acknowledgeSessionDeliveries(ledger, sessionWith('inbox', { status: 'ok', items: [] }));

    expect(readWorkerRecord(ledger, WORKER)?.reportedRevision).toBeUndefined();
    expect(workerHasUnread(readWorkerRecord(ledger, WORKER)!, readWorkerOutbox(ledger, WORKER))).toBe(true);
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
});
