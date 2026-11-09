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
import {
  acknowledgeWorkerRead,
  closeWorkerReceiptEvents,
  readWorkerOutbox,
  readWorkerRecord,
  type WorkerOutbox,
  type WorkerRecord,
} from './worker-records.js';

/** The delivery kind a worker report uses. */
export const WORKER_DELIVERY = 'worker';

/**
 * A handover the parent is holding right now.
 *
 * The parent read the report, but the turn that holds it has not been saved
 * yet, so the receipt for it is still to come. This is evidence in flight,
 * not a second answer about what was read: it can only ever say "the parent
 * has this in hand", never "the parent never had it".
 */
export interface HeldHandover {
  revision: number;
  notesCursor: number;
}

/**
 * Whether the worker finished with a report the parent has not acknowledged.
 *
 * The durable receipt answers this: `reportedRevision` is the revision the
 * parent has already been given, and it is the only thing that can say the
 * report was delivered for good. A handover in flight can only subtract,
 * because a report the parent is holding right now has its receipt still to
 * come.
 */
export function workerReportPending(record: WorkerRecord, held?: HeldHandover): boolean {
  return record.finished && (record.completionRevision ?? 0) > Math.max(record.reportedRevision ?? 0, held?.revision ?? 0);
}

/**
 * Whether the parent still has to hear about this worker.
 *
 * This is the one question the inbox listing and the wake both ask, and
 * they ask it through this function so they cannot disagree. The answer has
 * two parts, and they are not two truths:
 *
 * - the durable receipt says whether the report reached the parent for good,
 * - a handover in flight says the parent is holding it right now, with the
 *   receipt still to be written when the turn that read it is saved.
 *
 * The second part can only subtract. It never turns "still needed" into "not
 * needed" on the strength of memory alone: a report that was never received
 * stays needed, however long ago somebody looked at it.
 */
export function workerNeedsAttention(record: WorkerRecord, notes: WorkerOutbox, held?: HeldHandover): boolean {
  const notesPending = notes.notes.length > Math.max(notes.read, held?.notesCursor ?? 0);
  return workerReportPending(record, held) || notesPending;
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
  /**
   * Told about a receipt that could not be written.
   *
   * A receipt that fails to land is a real fault: the notification stays
   * unread, and the state machine that depends on it keeps waiting. It must
   * not be swallowed - a silent failure is the failure that is discovered
   * days later, when a notification is stuck and nobody knows why. Reporting
   * it here keeps the session save intact: the content is already on disk,
   * and only the bookkeeping failed.
   */
  onFailure?: (failure: { delivery: ToolDelivery; error: unknown }) => void;
}

/**
 * Writes the receipts for every handover the session holds.
 *
 * Returns the deliveries that were consumed, so the caller can clear the
 * handovers it has in flight.
 */
export function acknowledgeSessionDeliveries(ledger: ActivityLedger, session: SavedSession, options: ReceiptOptions = {}): ToolDelivery[] {
  const acknowledged: ToolDelivery[] = [];
  /**
   * The handovers this scan already consumed, by what they carry.
   *
   * The identity of a handover is the worker, the revision and the notes
   * cursor - not the worker alone. A parent polls a running worker and reads
   * it again once it has finished: two handovers of the same worker, and the
   * second one is the one that writes the completion receipt. Keyed by the
   * worker alone, the second handover would look like the first one and the
   * completion receipt would never be written.
   */
  const handled = new Set<string>();
  /** The workers the current contract already acknowledged, for the migration path below. */
  const handledWorkers = new Set<string>();
  const legacyBest = new Map<string, LegacyWorkerValue>();
  const report = (delivery: ToolDelivery, error: unknown): void => {
    options.onFailure?.({ delivery, error });
  };

  const conversation = session.conversation ?? [];

  for (const message of [...conversation, ...(session.conversationArchive ?? [])]) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || part.output.type !== 'json') continue;
      const output = part.output.value;

      // The current contract: the delivery path said what it handed over.
      // The declaration is the proof, so nothing else has to be consulted.
      for (const delivery of deliveriesOf(output)) {
        if (delivery.kind !== WORKER_DELIVERY) continue;
        // A handover that this very scan already wrote is not written twice.
        // Reading the same report twice - once through the inbox and once
        // through the poll - is a normal thing to do.
        if (handled.has(handoverKey(delivery))) continue;
        if (!writeReceipt(ledger, session.id, delivery, report)) continue;
        acknowledged.push(delivery);
        handled.add(handoverKey(delivery));
        handledWorkers.add(delivery.id);
      }

      // Conversations that were saved before deliveries existed still carry
      // the old shape: a poll result with the worker's revision inside it.
      // They are read for their own sake, so a conversation that is already on
      // disk still closes its notification. This is a migration path for old
      // data, not a pattern to keep matching: no new result is built this way.
      //
      // The best value per worker wins, not the first one found: a
      // conversation can hold a poll from before the worker finished and
      // another from after, and only the later one carries the completion.
      for (const legacy of legacyWorkerValues(part.toolName, output)) {
        const current = legacyBest.get(legacy.session);
        if (!current || legacy.revision > current.revision) legacyBest.set(legacy.session, legacy);
      }
    }
  }

  // The migration path runs after the current contract, so a worker that was
  // handed over the new way is never acknowledged the old way as well.
  for (const legacy of legacyBest.values()) {
    if (handledWorkers.has(legacy.session)) continue;
    const held = options.heldWorkerIds?.includes(legacy.session) === true;
    if (!held && legacy.session !== options.recoveryWorkerId) continue;
    const delivery: ToolDelivery = {
      kind: WORKER_DELIVERY,
      id: legacy.session,
      revision: legacy.revision,
      cursor: legacy.notesCursor,
    };
    if (!writeReceipt(ledger, session.id, delivery, report)) continue;
    acknowledged.push(delivery);
    handled.add(handoverKey(delivery));
    handledWorkers.add(legacy.session);
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
 * Three things are deliberate here.
 *
 * The first is the skip: a receipt that is already on disk is not rewritten.
 * The durable record is the truth about what was read, so consulting it first
 * keeps a long conversation from rewriting the same receipt on every save.
 *
 * The second is that the check and the write share one error policy. Both
 * touch the ledger, so both can fail, and a function that treats a failed
 * read as fatal and a failed write as nothing is a function with two rules.
 *
 * The third is that a failure is reported rather than swallowed. A receipt
 * that cannot be written must not fail the save of the session that holds the
 * content: the session is already on disk by then, and the caller repairs
 * the receipt on the next save. But it must not disappear either, because a
 * receipt that never lands is a notification that stays open for a reason
 * nobody can see. The reporting is what turns it into a visible fault.
 *
 * Returns false when the receipt could not be written, so the caller leaves
 * the handover alone and offers it again.
 */
function writeReceipt(
  ledger: ActivityLedger,
  parentId: string,
  delivery: ToolDelivery,
  report: (delivery: ToolDelivery, error: unknown) => void,
): boolean {
  try {
    if (durableStateCovers(ledger, delivery.id, delivery.revision, delivery.cursor ?? 0)) {
      // The receipt is already on disk, so there is nothing to write. The
      // event it answers can still be open, though: an event closes when its
      // receipt lands, and a later session is only the one that notices the
      // receipt is already there.
      closeWorkerReceiptEvents(ledger, delivery.id, delivery.revision, delivery.cursor ?? 0);
      return true;
    }
    acknowledgeWorkerRead(ledger, parentId, delivery.id, delivery.revision, delivery.cursor ?? 0);
    return true;
  } catch (error) {
    report(delivery, error);
    return false;
  }
}

interface LegacyWorkerValue {
  session: string;
  revision: number;
  notesCursor: number;
}

/**
 * What makes one handover different from another.
 *
 * The worker says which report it is; the revision says which version of it;
 * the cursor says how far the notes are read. Two handovers that agree on
 * all three are the same handover, and only one of them is worth writing.
 */
function handoverKey(delivery: ToolDelivery): string {
  return `${delivery.id}:${delivery.revision}:${delivery.cursor ?? 0}`;
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
