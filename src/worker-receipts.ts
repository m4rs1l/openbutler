/**
 * Turning a handover into a durable receipt.
 *
 * A notification is closed because the parent holds the report, not because a
 * tool result happens to look a certain way in the transcript. The handover
 * therefore declares itself: the delivery path puts what the caller now holds
 * into a reserved slot of the tool result, and this module reads that
 * declaration back out of the saved session and writes the durable receipt.
 *
 * Two properties make this work for every delivery path, not only for the
 * ones that exist today:
 *
 * - Nothing is matched by name. The old code looked for a tool called
 *   `subagent_poll` or `inbox` and for a payload shape of its own. A new
 *   delivery path, or a renamed tool, silently stopped closing its
 *   notifications. Here the declaration carries everything that is needed.
 * - Nothing depends on size. A tool result longer than the inline limit is
 *   replaced by a preview, and the preview does not contain the handover. The
 *   declaration sits beside the preview, so a forty kilobyte report and a
 *   forty byte one are the same case.
 */

import type { ActivityLedger } from './activity-ledger.js';
import { deliveriesOf, type ToolDelivery } from './delivery.js';
import type { SavedSession } from './session-store.js';
import { acknowledgeWorkerRead, readWorkerOutbox, readWorkerRecord, type WorkerOutbox, type WorkerRecord } from './worker-records.js';

/** The delivery kind a worker report uses. */
export const WORKER_DELIVERY = 'worker';

/**
 * Whether the parent still has to hear about this worker.
 *
 * One question, one answer. The durable receipt says whether the report was
 * read; the outbox cursor says how far the notes were read. Nothing else may
 * answer this question, because two answers mean two truths, and two truths
 * drift apart the moment the host restarts - and that drift is what made a
 * notification come back after it had already been opened.
 */
export function workerHasUnread(record: WorkerRecord, notes: WorkerOutbox): boolean {
  if (record.finished && (record.completionRevision ?? 0) > (record.reportedRevision ?? 0)) return true;
  return notes.notes.length > notes.read;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export interface ReceiptOptions {
  /**
   * The workers this session has a handover in flight for.
   *
   * This is not a read state: it says a handover is on its way to the
   * session. It is only consulted for conversations that were saved before
   * deliveries existed, because those carry no declaration and therefore
   * cannot prove on their own that the handover was theirs.
   */
  heldWorkerIds?: readonly string[];
  /**
   * A worker id whose receipt may be written even when this session holds no
   * handover for it.
   *
   * This is the crash recovery case: the host died after the conversation
   * was written but before the receipt was, so the parent is woken again and
   * the receipt is repaired from what is on disk.
   */
  recoveryWorkerId?: string;
}

/**
 * Writes the receipts for every handover the session holds.
 *
 * Returns the deliveries that were consumed, so the caller can clear the
 * handovers it has in flight.
 */
export function acknowledgeSessionDeliveries(ledger: ActivityLedger, session: SavedSession, options: ReceiptOptions = {}): ToolDelivery[] {
  const acknowledged: ToolDelivery[] = [];
  const handled = new Set<string>();
  for (const message of [...session.conversation, ...(session.conversationArchive ?? [])]) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || part.output.type !== 'json') continue;
      const output = part.output.value;

      // The current contract: the delivery path said what it handed over.
      // The declaration is the proof, so nothing else has to be consulted.
      for (const delivery of deliveriesOf(output)) {
        if (delivery.kind !== WORKER_DELIVERY) continue;
        writeReceipt(ledger, session.id, delivery);
        acknowledged.push(delivery);
        handled.add(delivery.id);
      }

      // Conversations that were saved before deliveries existed still carry
      // the old shape: a poll result with the worker's revision inside it.
      // They are read for their own sake, so a conversation that is already on
      // disk still closes its notification. This is a migration path for old
      // data, not a pattern to keep matching: no new result is built this way.
      for (const legacy of legacyWorkerValues(part.toolName, output)) {
        if (handled.has(legacy.session)) continue;
        const held = options.heldWorkerIds?.includes(legacy.session) === true;
        if (!held && legacy.session !== options.recoveryWorkerId) continue;
        writeReceipt(ledger, session.id, {
          kind: WORKER_DELIVERY,
          id: legacy.session,
          revision: legacy.revision,
          cursor: legacy.notesCursor,
        });
        acknowledged.push({
          kind: WORKER_DELIVERY,
          id: legacy.session,
          revision: legacy.revision,
          cursor: legacy.notesCursor,
        });
        handled.add(legacy.session);
      }
    }
  }
  return acknowledged;
}

/**
 * Whether the durable state already says everything a receipt write would say.
 *
 * A session is saved more than once per turn, and a conversation only grows,
 * so the same handover is seen again on every later save. Rewriting a receipt
 * that is already on disk buys nothing and costs a write each time.
 *
 * The durable record is the single truth about what was read, so it is also
 * the thing that decides whether a write is needed at all. The conditions
 * below mirror the write in `acknowledgeWorkerRead` exactly, so skipping can
 * never lose a change:
 *
 * - the completion revision is only written for a finished worker, and only
 *   when the revision is that worker's completion revision, and
 * - the notes cursor is only ever moved forward.
 */
export function durableStateCovers(ledger: ActivityLedger, workerId: string, revision: number, notesCursor: number): boolean {
  const record = readWorkerRecord(ledger, workerId);
  if (!record) return false;
  const outbox = readWorkerOutbox(ledger, workerId);
  const revisionCovered = !record.finished || revision !== record.completionRevision || (record.reportedRevision ?? 0) >= revision;
  const notesCovered = outbox.read >= Math.min(notesCursor, outbox.notes.length);
  return revisionCovered && notesCovered;
}

/**
 * Writes the durable receipt for one handover.
 *
 * Two things are deliberate here.
 *
 * The first is the skip: a receipt that is already on disk is not rewritten.
 * The durable record is the truth about what was read, so consulting it first
 * keeps a long conversation from rewriting the same receipt on every save.
 *
 * The second is the error handling. A receipt that cannot be written must not
 * fail the save of the session that holds the content: the session is already
 * on disk by then, and the worst case of a lost receipt is one extra wake-up,
 * which the host repairs from the saved conversation. Failing the save
 * instead would turn a receipt problem into a session that is never persisted.
 */
function writeReceipt(ledger: ActivityLedger, parentId: string, delivery: ToolDelivery): void {
  if (durableStateCovers(ledger, delivery.id, delivery.revision, delivery.cursor ?? 0)) return;
  try {
    acknowledgeWorkerRead(ledger, parentId, delivery.id, delivery.revision, delivery.cursor ?? 0);
  } catch {
    // The unread rule is derived from the durable record, so a receipt that
    // did not land leaves the notification unread and the host asks again.
  }
}

interface LegacyWorkerValue {
  session: string;
  revision: number;
  notesCursor: number;
}

/** The worker records an old-style tool result carries, if any. */
function legacyWorkerValues(toolName: string, output: unknown): LegacyWorkerValue[] {
  const candidates =
    toolName === 'subagent_poll'
      ? [output]
      : toolName === 'inbox' && isRecord(output) && Array.isArray(output.items)
        ? output.items.flatMap((item) => (isRecord(item) && item.source === 'Subagent' ? [item.content] : []))
        : [];
  const values: LegacyWorkerValue[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || typeof candidate.session !== 'string') continue;
    values.push({
      session: candidate.session,
      revision: typeof candidate.completionRevision === 'number' ? candidate.completionRevision : 0,
      notesCursor: typeof candidate.notesCursor === 'number' ? candidate.notesCursor : 0,
    });
  }
  return values;
}
