/** Worker/subagent domain, split out of daemon-host.ts (phase 2, slice b). */
import type { AgentSessionController, AgentSessionOptions } from '../agent-session.js';
import type { ModelRole } from '../model-roles.js';
import type { ActivityLedger, ObservedEventRow } from '../activity-ledger.js';
import { loadSavedSession, type SavedSession, type SessionEntry } from '../session-store.js';
import type { WorkspaceHost, PrivateSessionHost } from '../daemon-host.js';
import type { SubagentRequest } from '../tools/subagent.js';
import { WORKER_INSTRUCTIONS } from '../agent-instructions.js';
import type { WorkerNoteKind, WorkerRecord } from '../worker-records.js';
import { appendWorkerNote, completeWorker, readWorkerOutbox } from '../worker-records.js';
import type { ToolDelivery } from '../delivery.js';
import { machineWorkspaceRoot, resolveRestoreScope } from '../workspace-origin.js';
import { inboxId, inboxNotice } from '../inbox.js';
import { isToolRequestWhitelisted } from '../tool-permissions.js';
import { resolveSessionReference } from '../session-registry.js';
import { CUSTODIAN_WORKER_CAP_DEFAULTS, loadSettings, type CustodianSettings } from '../settings.js';

/** Running-worker limits, as the owner configured them. */
export type WorkerCaps = NonNullable<CustodianSettings['workerCaps']>;

/**
 * The caps in force for the next spawn. A spawn is the boundary the owner's setting is
 * read at: a worker that is already running keeps the width and depth it started with.
 */
export function configuredWorkerCaps(): WorkerCaps {
  return loadSettings().custodian?.workerCaps ?? CUSTODIAN_WORKER_CAP_DEFAULTS;
}

/**
 * Running-worker cap check (D12): width per main session, width per worker parent, and
 * the machine total. Returns the refusal message when a spawn must not start, or null
 * when there is room. The caps are passed in rather than read here, so the same call
 * that checks a spawn is the call that decided which limits apply to it.
 */
export function workerLimitError(input: {
  parentDepth: number;
  runningForParent: number;
  runningTotal: number;
  caps: WorkerCaps;
}): string | null {
  const perParent = input.parentDepth > 0 ? input.caps.perWorkerParent : input.caps.perSession;
  if (input.runningForParent >= perParent)
    return `This session already runs ${input.runningForParent} subagents (limit ${perParent}). Read its notification with inbox or stop it with subagent_stop, then retry.`;
  if (input.runningTotal >= input.caps.perMachine)
    return `This machine already runs ${input.runningTotal} subagents (limit ${input.caps.perMachine}). Wait for a completion notification in inbox or stop one (subagent_stop), then retry.`;
  return null;
}
/** Read-only research tool set for explorer workers. */
const EXPLORER_TOOLS = ['file_read', 'glob', 'grep', 'memory_search', 'session_list', 'session_search', 'session_read'] as const;
/** Core file and command tools for executor workers; MCP tools are never given to workers (P4 decision). */
const EXECUTOR_TOOLS = [
  'execute_command',
  'file_read',
  'file_write',
  'file_edit',
  'glob',
  'grep',
  'memory_search',
  'session_list',
  'session_search',
  'session_read',
] as const;

export interface WorkerServiceDeps {
  ledger: ActivityLedger;
  workers: Map<string, WorkerRecord>;
  options: { log: (message: string) => void };
  scheduleEventRetry: (at: number) => void;
  pumpEvents: () => void;
  /**
   * Handovers that are on their way to a session but are not saved yet.
   *
   * This is not a read state: it records that a poll happened, so a wake is
   * not repeated in the short window before the turn that contains it is
   * saved. Whether the report was read is answered by the durable receipt in
   * the worker record.
   */
  inFlightWorkerDeliveries: Map<string, Map<string, { revision: number; notesCursor: number }>>;
  findSessionController: (sessionId: string) => AgentSessionController | undefined;
  findLiveSessionById: (sessionId: string) => { workspace: WorkspaceHost; controller: AgentSessionController; main: boolean } | null;
  getCustodianWorkspace: (scopeRoot: string) => Promise<WorkspaceHost>;
  getWorkspace: (root: string) => Promise<WorkspaceHost>;
  custodianWorkspace: () => WorkspaceHost | null;
  readWorkerRecord: (ledger: ActivityLedger, workerId: string) => WorkerRecord | null;
  writeWorkerRecord: (ledger: ActivityLedger, workerId: string, record: WorkerRecord) => void;
  createPrivateSession: (
    workspace: WorkspaceHost,
    persistentKey?: string,
    isBackground?: boolean,
    extra?: { label?: string; options?: AgentSessionOptions; restoreSessionId?: string; modelRole?: ModelRole },
  ) => Promise<PrivateSessionHost>;
  signalStillNeeded: (event: ObservedEventRow) => boolean;
  /**
   * Whether the durable receipt for this event is still outstanding.
   *
   * The durable receipt is the only thing that may close an event. The
   * in-flight book says what the parent is holding right now; that may
   * suppress a duplicate wake, but it may never decide that an event is
   * finished, because a closed event is never woken again - a notification
   * that stays open and mute is worse than one that stays open and loud.
   */
  receiptOutstanding: (event: ObservedEventRow) => boolean;
  workspaces: Map<string, WorkspaceHost>;
  isClosing: () => boolean;
  acknowledgeSavedWorkerReads: (session: SavedSession, recoveryWorkerId?: string) => void;
  redactSensitiveText: (text: string) => string;
  inboxReminderMs: number;
}

export function createWorkerService(deps: WorkerServiceDeps) {
  const {
    ledger,
    workers,
    options,
    scheduleEventRetry,
    pumpEvents,
    findSessionController,
    findLiveSessionById,
    getCustodianWorkspace,
    getWorkspace,
    custodianWorkspace,
    readWorkerRecord,
    writeWorkerRecord,
    createPrivateSession,
    signalStillNeeded,
    receiptOutstanding,
    acknowledgeSavedWorkerReads,
    redactSensitiveText,
    workspaces,
    isClosing,
    inFlightWorkerDeliveries,
  } = deps;
  const INBOX_REMINDER_MS = deps.inboxReminderMs;
  /**
   * How often a notification nobody opens may re-arm its own wake before the
   * event is closed. Every retry delivers the same notice text, so an
   * unbounded retry turns one unread notification into permanent noise: the
   * parent sees the identical reminder every few minutes, forever.
   */

  /** Worker write leases (parallel-write policy): normalized path -> the worker that claimed it for its current run. */
  const workerFileLeases = new Map<string, string>();

  function deferWorkerEvent(event: ObservedEventRow, delay: number, reason: string): void {
    ledger.setEventState(event.id, 'pending', reason);
    if (delay > 0) {
      const due = Date.now() + delay;
      ledger.setState(`worker:retry:${event.id}`, String(due));
      scheduleEventRetry(due);
    }
  }

  async function processWorkerEvent(event: ObservedEventRow): Promise<void> {
    // The durable receipt decides whether the event is still open. The
    // in-flight book is consulted later, and only for the wake.
    if (!receiptOutstanding(event)) {
      ledger.setEventState(event.id, 'delivered');
      return;
    }
    const parentId = String(event.payload.parentSessionId);
    const persistedParent = loadSavedSession(parentId);
    if (persistedParent) acknowledgeSavedWorkerReads(persistedParent, String(event.payload.workerId));
    if (!receiptOutstanding(event)) {
      ledger.setEventState(event.id, 'delivered');
      return;
    }
    // The receipt is outstanding but the parent is holding the handover in
    // this very moment: it has read the report and the turn that holds it is
    // not saved yet. Waking it again would repeat a notice about something
    // it is already holding, so the event waits quietly for the receipt.
    // This wait is not a reminder: the notification was not ignored, it is
    // in flight.
    if (!signalStillNeeded(event)) {
      deferWorkerEvent(event, INBOX_REMINDER_MS, 'The parent is holding the handover; waiting for the receipt to land.');
      return;
    }
    let parent = findSessionController(parentId);
    if (!parent) {
      const saved = loadSavedSession(parentId);
      if (!saved) {
        ledger.setEventState(event.id, 'ignored', 'The parent session no longer exists.');
        return;
      }
      const root = resolveRestoreScope({
        storedRoot: saved.workspaceRoot,
        eventRoot: event.workspaceRoot,
        cwd: machineWorkspaceRoot(),
      }).root;
      // Restore the current custodian or workspace; never switch another owner's active session.
      if (!saved.workspaceRoot) await getCustodianWorkspace(root);
      else {
        const workspace = await getWorkspace(root);
        const lineage = readWorkerRecord(ledger, parentId);
        if (lineage?.finished && lineage.result?.error) {
          ledger.setEventState(event.id, 'ignored', 'The parent worker terminated; its parent owns recovery.');
          return;
        }
        if (lineage?.background && !lineage.result?.error && (lineage.mode === 'explorer' || lineage.mode === 'executor')) {
          const restored = await createPrivateSession(workspace, undefined, false, {
            label: 'Subagent',
            restoreSessionId: parentId,
            modelRole: 'worker',
            options: workerSessionOptions(
              workspace,
              { mode: lineage.mode, background: true, context: lineage.context ?? { paths: [] } },
              lineage.depth,
              configuredWorkerCaps(),
            ),
          });
          workers.set(parentId, lineage);
          parent = restored.controller;
        }
      }
      parent = parent ?? findSessionController(parentId);
      if (!parent) {
        // A parent that cannot be loaded is a persistent failure, not a transient
        // one: without a ceiling this branch retries forever (a live event spent
        // three days at one claim per 30 seconds).
        if (event.attempts >= 10) {
          ledger.setEventState(event.id, 'failed', 'The parent session could not be loaded after repeated attempts.');
          return;
        }
        deferWorkerEvent(event, 30_000, 'Waiting for the original parent session to be loaded.');
        return;
      }
    }
    if (parent.automaticWakeHeld) {
      deferWorkerEvent(event, 0, 'Automatic wake is held by the owner.');
      return;
    }
    const controller = parent;
    const attemptId = `${event.id}:attempt:${event.attempts}`;
    try {
      await controller.sendEvent({
        text: inboxNotice('Subagent', 1),
        images: [],
        eventId: attemptId,
        communication: { source: 'inbox' },
        ...(event.workspaceRoot ? { workspaceRoot: event.workspaceRoot } : {}),
        beforeDelivery: async () => {
          if (controller.getSnapshot().session.id !== parentId || !signalStillNeeded(event)) return null;
          return inboxNotice('Subagent', 1);
        },
      });
      await controller.flushSave();
      const result = controller.takeEventRunResult(attemptId);
      const error = result ? result.error : controller.getLastRunError();
      if (!receiptOutstanding(event)) ledger.setEventState(event.id, 'delivered');
      else if (controller.getSnapshot().session.id !== parentId)
        deferWorkerEvent(event, 30_000, 'The original parent is no longer selected.');
      else if (result?.skipped) deferWorkerEvent(event, 1000, 'Waiting for the parent tool result to be saved.');
      else if (error) deferWorkerEvent(event, controller.automaticWakeHeld ? 0 : INBOX_REMINDER_MS, error);
      else deferWorkerEvent(event, INBOX_REMINDER_MS, 'The subagent notification is still unread.');
    } catch (error) {
      if (isClosing()) ledger.setEventState(event.id, 'pending', 'Host stopped before parent delivery completed.');
      else
        deferWorkerEvent(
          event,
          controller.automaticWakeHeld ? 0 : INBOX_REMINDER_MS,
          error instanceof Error ? error.message : String(error),
        );
    }
  }

  /**
   * The workspace and private session behind a live session id, wherever on the host it lives.
   * A worker belongs to the workspace that spawned it, not to the workspace of whoever views it,
   * so every worker lookup is keyed by the worker id alone.
   */
  function liveSessionHost(sessionId: string): { workspace: WorkspaceHost; session: PrivateSessionHost } | null {
    const found = findLiveSessionById(sessionId);
    if (!found || found.main) return null;
    const session = found.workspace.privateSessions.get(sessionId);
    return session ? { workspace: found.workspace, session } : null;
  }

  /** The live worker session a client wants to view, with the workspace that hosts it. */
  function liveWorkerSession(workerSessionId: string): { workspace: WorkspaceHost; session: PrivateSessionHost } {
    if (!workers.has(workerSessionId)) throw new Error('That session is not a subagent worker.');
    const host = liveSessionHost(workerSessionId);
    if (!host) throw new Error('The subagent session is no longer live.');
    return host;
  }

  /** The worker a parent session is currently blocked on; a foreground parent has at most one running worker. */
  function runningWorkerId(parentSessionId: string): string {
    for (const [workerId, info] of workers) {
      if (info.parentSessionId !== parentSessionId) continue;
      if (liveSessionHost(workerId)?.session.controller.isBusy) return workerId;
    }
    throw new Error('That subagent is not running right now.');
  }

  /**
   * Subagent spawn. One worker session is created with an explicit context package and a
   * mode-restricted tool set. With background: false the caller waits and the worker's last
   * assistant message is returned as the report, uncut; with background: true the call returns
   * at once. Durable lifecycle signals wake the parent; inbox retrieves the
   * actual notes/report without copying worker text into the wake. Depth is
   * capped at two (custodian -> subagent -> child); only executor workers receive the subagent
   * tool, and only background workers receive parent_message. A foreground worker is stopped by
   * the parent's abort signal; a background worker outlives the call.
   */
  function workerSessionOptions(
    workspace: WorkspaceHost,
    request: Pick<SubagentRequest, 'mode' | 'background' | 'context'>,
    depth: number,
    caps: WorkerCaps,
  ): AgentSessionOptions {
    return {
      background: true,
      basePolicy: { role: 'worker', instructions: subagentInstruction(request) },
      tools: [
        ...(request.mode === 'explorer' ? EXPLORER_TOOLS : EXECUTOR_TOOLS),
        // Anyone who can start a child can steer and stop it (spec 10).
        ...(request.mode === 'executor' && depth < caps.depth ? ['subagent', 'inbox', 'subagent_stop', 'worker_message'] : []),
        ...(request.background ? ['parent_message'] : []),
      ],
      autoApprove: (approval) =>
        (approval.providerId === 'host' && ['subagent', 'parent_message', 'inbox', 'subagent_stop'].includes(approval.name)) ||
        isToolRequestWhitelisted(workspace.root, approval),
      writeGuard: (workerSessionId, path) => workerWriteGuard(workspace.root, workerSessionId, path),
    };
  }

  async function spawnSubagent(request: SubagentRequest, senderSessionId: string | undefined, signal?: AbortSignal): Promise<unknown> {
    if (!senderSessionId) return { status: 'error', error: 'The parent session could not be identified.' };
    const parent = findLiveSessionById(senderSessionId);
    if (!parent) return { status: 'error', error: 'Only a live session can spawn a subagent.' };
    const caps = configuredWorkerCaps();
    const depth = (workers.get(senderSessionId)?.depth ?? 0) + 1;
    if (depth > caps.depth) {
      return {
        status: 'denied',
        error: `Subagents may not spawn another layer: the limit is ${caps.depth} (custodian -> subagent -> child).`,
      };
    }
    const running = countRunningWorkers(senderSessionId);
    const limitError = workerLimitError({ parentDepth: depth - 1, runningForParent: running.forParent, runningTotal: running.total, caps });
    if (limitError) return { status: 'busy', error: limitError };
    parent.controller.flushSave();
    if (parent.controller.getSnapshot().sessionSaveError)
      return { status: 'error', error: 'The parent session could not be persisted before delegation.' };
    const workspace =
      parent.workspace === custodianWorkspace() ? await getWorkspace(parent.controller.runtime.workspaceRoot) : parent.workspace;
    const worker = await createPrivateSession(workspace, undefined, false, {
      label: 'Subagent',
      modelRole: 'worker',
      options: workerSessionOptions(workspace, request, depth, caps),
    });
    const workerId = worker.controller.getSnapshot().session.id;
    const workerRecord = {
      parentSessionId: senderSessionId,
      depth,
      mode: request.mode,
      background: request.background,
      startedAt: Date.now(),
      workspaceRoot: workspace.root,
      context: request.context,
      finished: false,
    };
    workers.set(workerId, workerRecord);
    writeWorkerRecord(ledger, workerId, { ...workerRecord, finished: false });
    if (request.background) {
      void worker.controller.sendMessage({ text: workerTaskText(request), images: [] }).catch((error: unknown) => {
        releaseWorkerLeases(workerId);
        worker.controller.flushSave();
        options.log(`Background subagent failed to run (session ${workerId}): ${String(error)}`);
        if (!isClosing() && !readWorkerRecord(ledger, workerId)?.finished) {
          completeWorker(ledger, workerId, { report: 'The worker did not start successfully.', error: String(error) });
          pumpEvents();
        }
      });
      return { status: 'started', session: workerId, notificationId: inboxId('Subagent', workerId), mode: request.mode, depth };
    }
    const onAbort = () => worker.controller.stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await worker.controller.sendMessage({ text: workerTaskText(request), images: [] });
      worker.controller.flushSave();
      const error = worker.controller.getLastRunError();
      markWorkerFinished(workerId);
      if (error) return { status: 'error', error: `The worker failed: ${error}`, session: workerId, mode: request.mode, depth };
      return {
        status: 'completed',
        session: workerId,
        mode: request.mode,
        depth,
        report: lastAssistantReport(worker.controller.getSnapshot().session.entries),
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      releaseWorkerLeases(workerId);
    }
  }

  /** The last assistant message of a transcript, secret-redacted and uncut. */
  function lastAssistantReport(entries: readonly SessionEntry[]): string {
    const lastAssistant = [...entries].reverse().find((entry) => entry.kind === 'assistant');
    const report = lastAssistant?.kind === 'assistant' ? lastAssistant.text : '';
    return redactSensitiveText(report).trim() || 'The worker finished without a text report.';
  }

  /** Host-observed worker activity: tool call count and the last tool identity. */
  function workerActivity(entries: readonly SessionEntry[]): { toolCalls: number; lastTool: string | null } {
    let toolCalls = 0;
    let lastTool: string | null = null;
    for (const entry of entries) {
      if (entry.kind !== 'tool') continue;
      toolCalls += 1;
      if (typeof entry.tool === 'string') lastTool = entry.tool;
    }
    return { toolCalls, lastTool };
  }

  /** A terminal run publishes one versioned, durable result and one parent event. */
  function finishBackgroundWorker(worker: PrivateSessionHost): void {
    if (isClosing()) return;
    const id = worker.controller.getSnapshot().session.id;
    releaseWorkerLeases(id);
    completeWorker(ledger, id, {
      report: lastAssistantReport(worker.controller.getSnapshot().session.entries),
      error: worker.controller.getLastRunError(),
    });
    worker.controller.flushSave();
    pumpEvents();
  }

  function markWorkerFinished(workerId: string): void {
    const record = readWorkerRecord(ledger, workerId) ?? workers.get(workerId);
    if (record) writeWorkerRecord(ledger, workerId, { ...record, finished: true });
  }

  function storeWorkerNote(input: { text: string; kind?: WorkerNoteKind }, senderSessionId: string | undefined): unknown {
    if (!senderSessionId) return { status: 'denied', error: 'The worker session could not be identified.' };
    const record = readWorkerRecord(ledger, senderSessionId);
    if (!record?.background) return { status: 'denied', error: 'Only a background subagent can leave parent notes.' };
    if (!findLiveWorker(senderSessionId)) return { status: 'error', error: 'The worker session is no longer live.' };
    appendWorkerNote(ledger, senderSessionId, input.text, input.kind ?? 'progress');
    pumpEvents();
    return { status: 'stored', session: senderSessionId };
  }

  /** `subagent_stop` host side: only the recorded parent may stop its live worker. */
  /** The live private session behind a worker id, wherever its workspace lives. */
  function findLiveWorker(workerId: string): PrivateSessionHost | undefined {
    return liveSessionHost(workerId)?.session;
  }

  /** Running workers (a live controller mid-run) counted for the caller and for the whole machine. */
  function countRunningWorkers(senderSessionId: string): { forParent: number; total: number } {
    let forParent = 0;
    let total = 0;
    for (const [workerId, record] of workers) {
      if (findLiveWorker(workerId)?.controller.isBusy !== true) continue;
      total += 1;
      if (record.parentSessionId === senderSessionId) forParent += 1;
    }
    return { forParent, total };
  }

  function normalizeLeasePath(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path;
  }

  /**
   * Parallel-write policy: the first running worker to write a file holds it until its run ends.
   * Other workers are refused; a lease left behind by a settled worker is taken over.
   */
  function workerWriteGuard(workspaceRoot: string, workerSessionId: string, path: string): string | null {
    const key = normalizeLeasePath(path);
    const holder = workerFileLeases.get(key);
    if (holder !== undefined && holder !== workerSessionId && findLiveWorker(holder)?.controller.isBusy === true) {
      const label = path.startsWith(workspaceRoot) ? path.slice(workspaceRoot.length).replace(/^[\\/]/, '') : path;
      return `Another running subagent (${holder.slice(0, 8)}) holds "${label}" until its run ends. Wait for its notification in inbox, stop it (subagent_stop), or work on a different file.`;
    }
    workerFileLeases.set(key, workerSessionId);
    return null;
  }

  /** Drop a worker's leases when its run ends; the file is free for the next worker. */
  function releaseWorkerLeases(workerSessionId: string): void {
    for (const [key, holder] of workerFileLeases) if (holder === workerSessionId) workerFileLeases.delete(key);
  }

  function stopWorker(input: { session: string }, senderSessionId: string | undefined): unknown {
    if (!senderSessionId) return { status: 'denied', error: 'The stopping session could not be identified.' };
    const reference = typeof input.session === 'string' ? input.session.trim() : '';
    const liveMatch = [...workers.keys()].filter((id) => id === reference || (reference.length >= 4 && id.startsWith(reference)));
    if (liveMatch.length > 1)
      return {
        status: 'ambiguous',
        error: `The prefix "${reference}" matches more than one worker; pass a longer prefix or the full id.`,
      };
    if (liveMatch.length === 0) return { status: 'not_found', error: `No worker session matches "${reference}".` };
    const workerId = liveMatch[0]!;
    const record = workers.get(workerId)!;
    if (record.parentSessionId !== senderSessionId)
      return { status: 'denied', error: 'Only the parent session that started this worker may stop it.' };
    const live = [...workspaces.values()]
      .map((candidate) => candidate.privateSessions.get(workerId))
      .find((session) => session !== undefined);
    if (!live) return { status: 'error', error: 'That worker is not running.' };
    live.controller.stop();
    return { status: 'stopped', session: workerId };
  }

  /**
   * The handover of a worker record to the session that asked for it.
   *
   * It says what the caller now holds: this revision of the report, and this
   * far into the notes. The host records it as the receipt, so the caller is
   * never asked about the same worker again and the host never has to look at
   * the report text to find out whether it was already read.
   */
  const workerDelivery = (workerId: string, revision: number, cursor: number): ToolDelivery => ({
    kind: 'worker',
    id: workerId,
    revision,
    cursor,
  });

  /** Subagent inbox content: only the recorded parent may read its own worker. */
  function pollWorker(input: { session: string }, senderSessionId: string | undefined): unknown {
    if (!senderSessionId) return { status: 'denied', error: 'The polling session could not be identified.' };
    const reference = typeof input.session === 'string' ? input.session.trim() : '';
    // Live workers resolve from the in-memory lineage map (no save needed); the
    // saved files are only the fallback for workers that already finished.
    const liveMatch = [...workers.keys()].filter((id) => id === reference || (reference.length >= 4 && id.startsWith(reference)));
    if (liveMatch.length > 1)
      return {
        status: 'ambiguous',
        error: `The prefix "${reference}" matches more than one worker; pass a longer prefix or the full id.`,
      };
    let workerId: string | null = liveMatch.length === 1 ? liveMatch[0]! : null;
    if (!workerId && readWorkerRecord(ledger, reference)) workerId = reference;
    if (!workerId) {
      const resolution = resolveSessionReference(reference);
      if (resolution.kind === 'invalid')
        return { status: 'invalid', error: 'session must be a full id or a unique prefix of at least four hex characters.' };
      if (resolution.kind === 'none') return { status: 'not_found', error: `No saved session matches "${reference}".` };
      if (resolution.kind === 'ambiguous')
        return {
          status: 'ambiguous',
          error: `The prefix "${reference}" matches more than one session; pass a longer prefix or the full id.`,
          candidates: resolution.candidates,
        };
      workerId = resolution.session.id;
    }
    const record = readWorkerRecord(ledger, workerId) ?? workers.get(workerId);
    if (!record) return { status: 'denied', error: 'That session is not a subagent worker.' };
    if (record.parentSessionId !== senderSessionId)
      return { status: 'denied', error: 'Only the parent session that started this worker may poll it.' };
    const outbox = readWorkerOutbox(ledger, workerId);
    // The handover is marked as in flight here: the caller holds this content
    // now, and the receipt is written when the session is saved. Until then
    // the worker must not wake the parent again about the same revision.
    const inFlight = inFlightWorkerDeliveries.get(senderSessionId) ?? new Map<string, { revision: number; notesCursor: number }>();
    const previous = inFlight.get(workerId);
    const notes = outbox.notes.slice(Math.max(outbox.read, previous?.notesCursor ?? 0));
    const completionRevision = record.finished ? (record.completionRevision ?? 0) : 0;
    const notesCursor = outbox.notes.length;
    inFlight.set(workerId, { revision: completionRevision, notesCursor });
    inFlightWorkerDeliveries.set(senderSessionId, inFlight);

    const live = [...workspaces.values()]
      .map((candidate) => candidate.privateSessions.get(workerId))
      .find((session) => session !== undefined);
    if (live) {
      const error = live.controller.getLastRunError();
      const liveEntries = live.controller.getSnapshot().session.entries;
      const finished = !live.controller.isBusy && (error !== null || hasAssistantMessage(live.controller));
      const activity = workerActivity(liveEntries);
      return {
        status: finished ? 'finished' : 'running',
        session: workerId,
        mode: record.mode,
        depth: record.depth,
        background: record.background,
        notes,
        completionRevision,
        notesCursor,
        delivery: workerDelivery(workerId, completionRevision, notesCursor),
        report: finished ? (record.result?.report ?? lastAssistantReport(liveEntries)) : null,
        error: finished ? (record.result?.error ?? error) : error,
        toolCalls: activity.toolCalls,
        lastTool: activity.lastTool,
        elapsedSec: Math.floor((Date.now() - record.startedAt) / 1000),
      };
    }
    const saved = loadSavedSession(workerId);
    const savedEntries = saved?.entries ?? [];
    const savedActivity = workerActivity(savedEntries);
    return {
      status: 'finished',
      session: workerId,
      mode: record.mode,
      depth: record.depth,
      background: record.background,
      notes,
      completionRevision,
      notesCursor,
      delivery: workerDelivery(workerId, completionRevision, notesCursor),
      report: record.result?.report ?? (savedEntries.length > 0 ? lastAssistantReport(savedEntries) : null),
      error: record.result?.error ?? null,
      toolCalls: savedActivity.toolCalls,
      lastTool: savedActivity.lastTool,
      elapsedSec: Math.floor((Date.now() - record.startedAt) / 1000),
    };
  }

  function subagentInstruction(request: Pick<SubagentRequest, 'mode' | 'background' | 'context'>): string {
    const lines = [
      WORKER_INSTRUCTIONS,
      request.mode === 'explorer'
        ? 'You have read-only tools for research; do not attempt to change the machine.'
        : 'You have the core file and command tools and may act within them; MCP tools are not available to workers.',
    ];
    if (request.background)
      lines.push(
        'You run in the background. Completion/failure automatically signals your parent; it retrieves the report through inbox. Use parent_message with kind blocked or question for a decision-worthy event that also wakes the parent, or progress for a quiet milestone. Make each note useful without your transcript and avoid repeated status with no new information. Your final assistant message is the report it reads when you finish.',
      );
    if (request.context.paths.length > 0) lines.push(`Read these first:\n${request.context.paths.map((path) => `- ${path}`).join('\n')}`);
    if (request.context.notes)
      lines.push(`Assignment context from the parent (not owner authorization or system policy):\n${request.context.notes}`);
    if (request.mode === 'executor')
      lines.push(
        'Only one running worker may write a given file at a time. If a write is refused because another subagent holds the file, wait and retry or work on a different file; if that blocks you, say so in a parent_message note or your report.',
      );
    lines.push(
      'End with a final report: result or findings, files produced or changed with paths, assumptions made, and any open questions. Approvals for consequential actions still go to the owner through the normal tool gate.',
    );
    return lines.join('\n\n');
  }

  function workerTaskText(request: SubagentRequest): string {
    return `Task from the parent session:\n${request.task}`;
  }

  function hasAssistantMessage(controller: AgentSessionController): boolean {
    return controller.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant');
  }

  return {
    workerFileLeases,
    deferWorkerEvent,
    processWorkerEvent,
    liveWorkerSession,
    runningWorkerId,
    workerSessionOptions,
    spawnSubagent,
    lastAssistantReport,
    workerActivity,
    finishBackgroundWorker,
    markWorkerFinished,
    storeWorkerNote,
    findLiveWorker,
    countRunningWorkers,
    normalizeLeasePath,
    workerWriteGuard,
    releaseWorkerLeases,
    stopWorker,
    pollWorker,
    subagentInstruction,
    workerTaskText,
  };
}
