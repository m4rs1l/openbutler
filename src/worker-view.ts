/**
 * What a worker is and how a client opens its view — in one dependency-free
 * place. The CLI imports this for the transcript rows and the entry path; the
 * web bundle may import it the same way (no Node or React imports allowed here).
 *
 * Display strings stay in tool-display.ts. This module owns the *identity* and
 * *viewable state* of a worker call, not how it is rendered.
 */
import { toolEntryCommand } from './tool-display.js';
import type { SessionEntry } from './session-store.js';

export type SubagentToolEntry = Extract<SessionEntry, { kind: 'tool' }>;
export type SubagentToolCall = SubagentToolEntry & { running?: boolean | undefined; preparing?: boolean | undefined };

/** A tool entry that is one `subagent` worker call, or undefined. */
export function isSubagentToolEntry(entry: SessionEntry | undefined): entry is SubagentToolEntry {
  if (!entry || entry.kind !== 'tool') return false;
  // New rows carry the namespaced tool; legacy rows predate the tool field and
  // were recognized by the display command, kept for stored transcripts.
  if (entry.tool !== undefined) return entry.tool === 'host:subagent';
  return /^subagent (explorer|executor)\b/.test(toolEntryCommand(entry));
}

/**
 * The worker session recorded on the entry — the field first, then the legacy
 * JSON-in-result record. Null while the worker is still preparing/running or
 * when no record exists, never undefined.
 */
export function workerSessionIdOf(entry: SubagentToolEntry): string | null {
  if (typeof entry.session === 'string' && entry.session) return entry.session;
  // Results that are plain text carry no id; only JSON results can, and only
  // the `session` member is meaningful.
  try {
    const parsed: unknown = JSON.parse(entry.result);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const session = (parsed as { session?: unknown }).session;
    return typeof session === 'string' && session ? session : null;
  } catch {
    return null;
  }
}

/** How settled the worker of this tool call is, as seen by a viewing client. */
export type WorkerViewTarget =
  /** The worker may still be running; the host resolves the live child of this parent. */
  | { kind: 'running' }
  /** The worker finished with a known id. */
  | { kind: 'view'; workerSessionId: string }
  /** No way to name a worker session on this entry at all. */
  | { kind: 'none' };

export function workerViewTargetOf(entry: SubagentToolEntry): WorkerViewTarget {
  if (entry.running === true || entry.preparing === true) return { kind: 'running' };
  const workerSessionId = workerSessionIdOf(entry);
  return workerSessionId ? { kind: 'view', workerSessionId } : { kind: 'none' };
}

/**
 * Index of the newest worker call in an entry list — the one a "open latest"
 * gesture should open — or null. Newest wins: the user's attention follows
 * the delegate work visible now, not an older settled call.
 */
export function lastWorkerEntryIndex(entries: readonly SessionEntry[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isSubagentToolEntry(entries[index])) return index;
  }
  return null;
}

export type WorkerViewAttach =
  /** Attach to the worker the parent session is currently blocked on. */
  | { runningWorkerOf: string }
  /** Attach to the settled worker the tool call started. */
  | { workerSessionId: string };

/**
 * Attach options for opening this worker from the session that spawned it,
 * or null when the entry cannot name its worker (settled without a recorded
 * session id, or a call that never started one).
 */
export function workerViewAttach(entry: SubagentToolEntry, parentSessionId: string): WorkerViewAttach | null {
  const target = workerViewTargetOf(entry);
  if (target.kind === 'running') return { runningWorkerOf: parentSessionId };
  if (target.kind === 'view') return { workerSessionId: target.workerSessionId };
  return null;
}
