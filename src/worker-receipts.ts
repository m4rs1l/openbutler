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
import { acknowledgeWorkerRead, type WorkerOutbox, type WorkerRecord } from './worker-records.js';

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
        acknowledgeWorkerRead(ledger, session.id, delivery.id, delivery.revision, delivery.cursor ?? 0);
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
        acknowledgeWorkerRead(ledger, session.id, legacy.session, legacy.revision, legacy.notesCursor);
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
