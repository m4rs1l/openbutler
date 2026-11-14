import { randomUUID } from 'node:crypto';
import { canonicalScopeRoot } from './workspace-origin.js';
import { DaemonFrameDecoder } from './daemon-frames.js';
import { createConnection, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AgentSessionClient,
  AgentSessionRuntimeView,
  AgentSessionSnapshot,
  AgentSessionView,
  ApprovalDecision,
  QueuedMessage,
} from './agent-session.js';
import { getDaemonEndpoint } from './daemon.js';
import { resolveActiveBackend } from './backend-registry.js';
import {
  DAEMON_PROTOCOL_VERSION,
  MAX_DAEMON_FRAME_BYTES,
  type AttachResult,
  type DaemonEvent,
  type DaemonResponse,
  type RuntimeViewData,
  type SessionEntriesPatch,
  type SessionSnapshotData,
} from './daemon-protocol.js';
import { listSavedSessions, type SessionEntry, type SessionEntriesRange, type SessionSummary, type NoticeTone } from './session-store.js';
import { LocalNoticeList, LOCAL_NOTICE_TTL_MS, MAX_LOCAL_NOTICES } from './local-notices.js';
import type { ApprovalMode } from './settings.js';
import { LOCAL_CLIENT_KINDS, type LocalClientKind } from './communication.js';

const CLIENT_CONNECT_TIMEOUT_MS = 10_000;
/** A remote backend expects `auth` as the first frame; this bounds the wait for its verdict. */
const AUTH_HANDSHAKE_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type AttachOptions = {
  chatSessionId?: string;
  newChatSession?: boolean;
  projectId?: string | null;
  clientKind?: LocalClientKind;
  isolatedSession?: boolean;
  scheduleId?: string;
  /** Attach view-only to one live subagent worker session. */
  workerSessionId?: string;
  /** Attach view-only to the worker a parent session is currently blocked on. */
  runningWorkerOf?: string;
  /**
   * Keep only the newest this-many transcript entries in memory, paging older
   * history from the host on demand. A web client sets it so a long chat cannot
   * spend the whole transcript on every attach; the terminal leaves it unset
   * because its scrollback needs the full history. An older host ignores it and
   * returns everything, which the client then windows itself.
   */
  entriesWindow?: number;
};

/**
 * What a surface opens when it starts: the chat the owner left off in, or a
 * new one when this workspace has no chat yet. The custodian is the host's own
 * conversation, reached through the channels that drive it, so no surface
 * attaches to it.
 */
export function resumeChatAttach(clientKind: LocalClientKind): AttachOptions {
  // Chats belong to the machine, not to one folder: every surface resumes the same list,
  // and a chat's own project decides where it runs. The custodian is never in this list.
  const resumed = listSavedSessions(null)[0];
  return resumed ? { clientKind, chatSessionId: resumed.id } : { clientKind, newChatSession: true };
}

export interface DaemonSessionConnection extends AgentSessionClient {
  /** The host's imported backend identity; null or absent means it is not known. */
  readonly hostBuildId?: string | null;
}

export async function connectDaemonSession(workspacePath: string, options: AttachOptions): Promise<DaemonSessionConnection> {
  const workspaceRoot = canonicalScopeRoot(workspacePath);
  const socket = await connectSocket();
  const client = new DaemonSessionClient(socket, workspaceRoot, options);
  try {
    await client.attach(options);
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

class DaemonSessionClient implements DaemonSessionConnection {
  private frames = new DaemonFrameDecoder(MAX_DAEMON_FRAME_BYTES);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<() => void>();
  private snapshot: AgentSessionSnapshot | null = null;
  // Host patches address this array. The rendered snapshot also contains local
  // notices, whose expiry/eviction must never change the host's index space.
  private serverEntries: SessionEntry[] = [];
  /**
   * Absolute host index of `serverEntries[0]`. Zero when this client holds the
   * whole transcript; otherwise the start of the tail window it keeps. Host
   * patches address absolute indices, so every update is translated by this.
   */
  private entriesFrom = 0;
  /** Full transcript length on the host, which the window itself does not reach. */
  private totalEntries = 0;
  /** The window this client keeps, or null when it holds the full transcript. */
  private entriesWindow: number | null = null;
  private closed = false;
  private connectionFailureReported = false;
  private reconnecting = false;
  private intentionalShutdown = false;
  /**
   * Client-local notices (connection loss, IPC failures, host pings). The host
   * does not know about them, so they are merged back into the transcript at
   * the position they arrived instead of being pinned to the end: a notice
   * parked below every later message never reads as old. They expire on their
   * own, and the count is capped.
   */
  private readonly localNotices = new LocalNoticeList(MAX_LOCAL_NOTICES, LOCAL_NOTICE_TTL_MS);
  private localNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private workspaceKey: string;
  /** The host's launch entry, carried on every attach. */
  hostEntry: string | null = null;
  /** Refreshed from attach metadata, never from the files a rebuild can overwrite. */
  hostBuildId: string | null = null;
  private savedSessions: SessionSummary[] = [];

  readonly runtime: AgentSessionRuntimeView;

  constructor(
    private socket: Socket,
    private readonly workspaceRoot: string,
    private attachOptions: AttachOptions = {},
  ) {
    this.workspaceKey = process.platform === 'win32' ? workspaceRoot.toLocaleLowerCase('en-US') : workspaceRoot;
    this.runtime = {
      workspaceRoot,
      modelName: 'Connecting…',
      providerName: 'Connecting…',
      providerId: '',
      modelId: '',
      contextWindowTokens: null,
      supportsVision: false,
      reasoningVariants: [],
      reasoningMetadataSource: null,
      reasoningSupport: 'model-unsupported',
      reasoningDefault: 'default',
      reasoningPreference: 'default',
      saveReasoningPreference: (variantId) => {
        this.runtime.reasoningDefault = variantId;
        this.runtime.reasoningPreference = variantId;
        void this.request('runtime.save-reasoning', { variantId }).catch(() => {});
      },
      showReasoningDefault: true,
      saveShowReasoningPreference: (visible) => {
        this.runtime.showReasoningDefault = visible;
        void this.request('runtime.save-show-reasoning', { visible }).catch(() => {});
      },
      approvalMode: 'workspace',
      saveApprovalModePreference: (mode: ApprovalMode) => {
        const previous = this.runtime.approvalMode ?? 'workspace';
        this.runtime.approvalMode = mode;
        void this.request('runtime.save-approval-mode', { mode }).catch((error: unknown) => {
          if (this.runtime.approvalMode === mode) this.runtime.approvalMode = previous;
          this.addLocalNotice(error);
        });
      },
    };
    this.bindSocket(socket);
  }

  get isBusy(): boolean {
    return this.snapshot?.busy ?? false;
  }

  getSnapshot = (): AgentSessionSnapshot => {
    if (!this.snapshot) throw new Error('The OpenButler host session has not attached yet.');
    return this.snapshot;
  };

  /**
   * The host's entries only. The merged snapshot also carries the notices this
   * client added on its own, and those sit inside the array, so a consumer that
   * addresses entries by index has to read this instead.
   */
  getServerEntries = (): readonly SessionEntry[] => {
    if (!this.snapshot) throw new Error('The OpenButler host session has not attached yet.');
    return this.serverEntries;
  };

  getServerEntriesFrom = (): number => this.entriesFrom;

  getServerEntryCount = (): number => this.totalEntries;

  /** Pages older history from the host, which always holds the full transcript. */
  fetchEntriesRange(before: number, limit: number): Promise<SessionEntriesRange> {
    return this.request<SessionEntriesRange>('session.entries-range', { before, limit });
  }

  /** Resolves an attachment across the full transcript, including history below the window. */
  findAttachment(id: string): Promise<{ path: string; mediaType: string } | null> {
    // `attachmentId`, not `id`: the request envelope reserves `id` for correlation.
    return this.request<{ path: string; mediaType: string } | null>('session.find-attachment', { attachmentId: id });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async attach(options: AttachOptions): Promise<void> {
    this.attachOptions = options;
    this.entriesWindow = options.entriesWindow ?? null;
    const result = await this.request<AttachResult>('attach', {
      workspaceRoot: this.workspaceRoot,
      clientKind: options.clientKind ?? 'terminal',
      ...(options.chatSessionId ? { chatSessionId: options.chatSessionId } : {}),
      ...(options.newChatSession ? { newChatSession: true } : {}),
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
      ...(options.isolatedSession ? { isolatedSession: true } : {}),
      ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      ...(options.workerSessionId ? { workerSessionId: options.workerSessionId } : {}),
      ...(options.runningWorkerOf ? { runningWorkerOf: options.runningWorkerOf } : {}),
      ...(options.entriesWindow !== undefined ? { entriesWindow: options.entriesWindow } : {}),
    });
    if (!isAttachResult(result)) throw new Error('The OpenButler host returned an invalid session attachment.');
    this.hostEntry = typeof result.hostEntry === 'string' && result.hostEntry ? result.hostEntry : null;
    this.hostBuildId = typeof result.hostBuildId === 'string' && result.hostBuildId ? result.hostBuildId : null;
    // A host that cannot even identify a web client is older than one that cannot open chats, so
    // it is reported first: the owner should see the cause, not the first symptom of it.
    if (options.clientKind === 'web' && result.clientKind !== 'web')
      throw new Error('Restart the OpenButler host to identify web messages correctly: openbutler restart');
    if ((options.chatSessionId || options.newChatSession) && result.sessionAttachments !== true)
      throw new Error('Restart the OpenButler host to enable independent chats. The current run has been kept running.');
    if (options.chatSessionId || options.newChatSession) {
      if (typeof result.workspaceKey !== 'string') throw new Error('The host did not provide a chat binding.');
      this.workspaceKey = result.workspaceKey;
    } else if (typeof result.workspaceKey === 'string') {
      // A worker view binds to the workspace that hosts the worker, which can differ
      // from the root this client named; follow-up requests must use the host's key.
      this.workspaceKey = result.workspaceKey;
    }
    if (options.chatSessionId && result.snapshot.session.id !== options.chatSessionId)
      throw new Error('The host attached to a different chat. This connection cannot be used.');
    if (options.newChatSession) {
      const { newChatSession: _newChat, projectId: _project, ...rest } = options;
      this.attachOptions = { ...rest, chatSessionId: result.snapshot.session.id };
    }
    this.applyRuntime(result.runtime);
    this.savedSessions = result.savedSessions;
    this.installSnapshot(result.snapshot);
    this.publish();
  }

  private bindSocket(socket: Socket): void {
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      if (socket === this.socket) this.consume(chunk);
    });
    socket.on('close', () => this.handleClose(new Error('Connection to the OpenButler host closed.'), socket));
    socket.on('error', (error) => this.handleClose(error, socket));
  }

  addEntry(entry: SessionEntry): void {
    void this.request('session.add-entry', { entry }).catch((error: unknown) => this.addLocalNotice(error));
  }

  approveToolCall(decision: ApprovalDecision, requestId = this.snapshot?.pendingApprovalId ?? undefined): void {
    if (!requestId) return;
    void this.request('session.approve', { decision, approvalId: requestId }).catch((error: unknown) => this.addLocalNotice(error));
  }

  answerQuestion(answer: string | null, questionId = this.snapshot?.pendingQuestion?.id ?? undefined): void {
    if (!questionId) return;
    void this.request('session.answer', { answer, questionId }).catch((error: unknown) => this.addLocalNotice(error));
  }

  stop(options: { keepQueue?: boolean; holdQueue?: boolean } = {}): void {
    const payload: { keepQueue?: boolean; holdQueue?: boolean } = {};
    if (options.keepQueue === true) payload.keepQueue = true;
    if (options.holdQueue === true) {
      payload.keepQueue = true;
      payload.holdQueue = true;
    }
    void this.request('session.stop', payload).catch((error: unknown) => this.addLocalNotice(error));
  }

  sendMessage(message: QueuedMessage): Promise<void> {
    return this.request('session.send', { message }).then(
      () => undefined,
      (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        // A view-only attachment cannot submit turns. That is a fact about the
        // attachment rather than a failed request, so the reader is told and the
        // exception does not escape into the UI.
        if (/view-only/i.test(text)) {
          this.addLocalNotice(text, 'info');
          return undefined;
        }
        throw error;
      },
    );
  }

  manageQueuedMessage(id: string, action: 'steer' | 'remove', sessionId: string): Promise<void> {
    return this.request('session.queue', { messageId: id, queueAction: action, sessionId }).then(() => undefined);
  }

  compact(recovery = false): Promise<void> {
    return this.submit('session.compact', { ...(recovery ? { recovery: true } : {}) });
  }

  // The host resolves the name against the shared command registry, so this
  // client never decides what a name means; failures land as a session notice.
  command(name: string, payload: Record<string, unknown> = {}): Promise<void> {
    return this.submit('session.command', { name, ...payload });
  }

  selectModel(providerId: string, modelId: string): Promise<void> {
    return this.request('session.select-model', { providerId, modelId }).then(() => undefined);
  }

  /**
   * The effort belongs to this chat: the host records it with the session and
   * answers with the view that session now runs with. The machine default is
   * never written from here.
   */
  setReasoningPreference(variantId: string): Promise<void> {
    return this.request('runtime.save-reasoning', { variantId }).then(() => undefined);
  }

  /** The visibility belongs to this chat, exactly like the effort does. */
  setShowReasoningPreference(visible: boolean): Promise<void> {
    return this.request('runtime.save-show-reasoning', { visible }).then(() => undefined);
  }

  setApprovalMode(mode: ApprovalMode): Promise<void> {
    return this.request('runtime.save-approval-mode', { mode }).then(() => undefined);
  }

  listSessions(): Promise<SessionSummary[]> {
    return this.request<SessionSummary[]>('session.list');
  }

  // A client holds one attachment at a time; the host opens the requested chat
  // as its own attachment, so this never moves another surface's controller.
  loadSession(id: string): Promise<AgentSessionView | null> {
    return this.request<AgentSessionView | null>('session.load', { sessionId: id });
  }

  createNewSession(projectId?: string | null): Promise<void> {
    return this.request('session.new', projectId === undefined ? {} : { projectId }).then(() => undefined);
  }

  selectProject(projectId: string | null, sessionId: string): Promise<void> {
    return this.request('session.select-project', { projectId, sessionId }).then(() => undefined);
  }

  async flushSave(): Promise<void> {
    await this.request('session.flush');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.localNoticeTimer !== null) {
      clearTimeout(this.localNoticeTimer);
      this.localNoticeTimer = null;
    }
    this.socket.end();
    this.handleClose(new Error('This OpenButler client detached from the host.'), this.socket);
  }

  private async request<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.closed || this.socket.destroyed) throw new Error('The OpenButler host connection is closed.');
    const id = randomUUID();
    const request =
      JSON.stringify({
        ...payload,
        version: DAEMON_PROTOCOL_VERSION,
        id,
        action,
        ...(action === 'attach' ? {} : { workspaceKey: this.workspaceKey }),
      }) + '\n';
    if (Buffer.byteLength(request, 'utf8') > MAX_DAEMON_FRAME_BYTES)
      throw new Error('The request exceeded the OpenButler host frame limit.');
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          rejectRequest(new Error(`OpenButler host request timed out: ${action}`));
        },
        action === 'attach' ? 90_000 : 30_000,
      );
      this.pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timer,
      });
      this.socket.write(request, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private async submit(action: string, payload: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.request(action, payload);
    } catch (error) {
      this.addLocalNotice(error);
    }
  }

  private consume(chunk: Buffer): void {
    let frames: Buffer[];
    try {
      frames = this.frames.append(chunk);
    } catch (error) {
      this.socket.destroy(error as Error);
      return;
    }
    for (const frame of frames) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.toString('utf8'));
      } catch {
        this.socket.destroy(new Error('The OpenButler host sent invalid JSON.'));
        return;
      }
      if (isDaemonEvent(parsed)) {
        this.applyEvent(parsed);
        continue;
      }
      if (!isDaemonResponse(parsed)) {
        this.socket.destroy(new Error('The OpenButler host sent an invalid IPC frame.'));
        return;
      }
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        // A response that matches no request (for example, the host rejecting an oversized frame
        // before it could be correlated) must not vanish; surface it on the session.
        if (!parsed.ok) this.addLocalNotice(new Error(parsed.error));
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      if (!parsed.ok) pending.reject(new Error(parsed.error));
      else pending.resolve(parsed.result);
    }
  }

  /**
   * Installs a snapshot from the host. The attach response may already be a tail
   * window (`entriesFrom` present); a broadcast snapshot event always carries the
   * full transcript. Either way a windowed client keeps only the tail, and the
   * streaming entry resolves against the entries it actually holds.
   */
  private installSnapshot(data: SessionSnapshotData): void {
    const fresh = snapshotFromData(data);
    if (data.entriesFrom !== undefined) {
      this.serverEntries = data.session.entries;
      this.entriesFrom = data.entriesFrom;
      this.totalEntries = data.totalEntries ?? data.session.entries.length;
    } else {
      const windowed = this.windowFull(data.session.entries);
      this.serverEntries = windowed.entries;
      this.entriesFrom = windowed.from;
      this.totalEntries = windowed.total;
    }
    this.snapshot = { ...fresh, session: { ...fresh.session, entries: this.withLocalNotices(this.serverEntries) } };
  }

  /** The tail window of a full transcript, or the whole thing when this client does not window. */
  private windowFull(full: SessionEntry[]): { entries: SessionEntry[]; from: number; total: number } {
    if (this.entriesWindow === null) return { entries: full, from: 0, total: full.length };
    const from = Math.max(0, full.length - this.entriesWindow);
    return { entries: full.slice(from), from, total: full.length };
  }

  /**
   * Applies a host patch to the window. Host indices are absolute and this client
   * holds `[entriesFrom, totalEntries)`, so each update is translated and anything
   * below the window is dropped. Appends grow the tail, a replace-all re-windows,
   * and the front is trimmed once the window doubles — bounding memory without
   * ever changing the host's index space.
   */
  private applyPatchedEntries(patch: SessionEntriesPatch | undefined): void {
    if (!patch) return;
    if (patch.kind === 'replace-all') {
      const windowed = this.windowFull(patch.entries);
      this.serverEntries = windowed.entries;
      this.entriesFrom = windowed.from;
      this.totalEntries = windowed.total;
      return;
    }
    const entries = [...this.serverEntries];
    for (const update of patch.appendText) {
      const local = update.index - this.entriesFrom;
      const entry = entries[local];
      if (
        local >= 0 &&
        local < entries.length &&
        (entry?.kind === 'assistant' || entry?.kind === 'reasoning') &&
        typeof update.delta === 'string'
      ) {
        // Keep the rest of the entry: the host can add a field (a stamped
        // thinking duration) while the text keeps growing.
        entries[local] = { ...entry, text: entry.text + update.delta };
      }
    }
    for (const update of patch.replace) {
      const local = update.index - this.entriesFrom;
      // An index outside the window is history this client no longer holds; the
      // host's absolute space stays dense, so skipping it leaves no hole here.
      if (!Number.isInteger(local) || local < 0 || local >= entries.length) continue;
      entries[local] = update.entry;
    }
    entries.push(...patch.append);
    this.totalEntries += patch.append.length;
    if (this.entriesWindow !== null && entries.length > this.entriesWindow * 2) {
      const drop = entries.length - this.entriesWindow;
      this.serverEntries = entries.slice(drop);
      this.entriesFrom += drop;
    } else {
      this.serverEntries = entries;
    }
  }

  private applyEvent(event: DaemonEvent): void {
    if (event.event === 'notification') {
      if (event.title === 'OpenButler host stopping') this.intentionalShutdown = true;
      if (!event.title.trim()) {
        // An owner-directed message delivered over the terminal is content, not
        // a status ping: it becomes a session entry so it keeps its place and
        // survives a reconnect, like any other turn.
        void this.request('session.add-entry', {
          entry: { kind: 'notice', text: event.message } satisfies SessionEntry,
        }).catch((error: unknown) => this.addLocalNotice(error));
        return;
      }
      this.addLocalNotice(`${event.title}\n${event.message}`);
      return;
    }
    if (event.event === 'snapshot') {
      this.installSnapshot(event.snapshot);
      this.applyRuntime(event.runtime);
      this.publish();
      return;
    }
    if (!this.snapshot) return;
    this.applyPatchedEntries(event.patch.entriesPatch);
    const session = { ...event.patch.session, entries: this.withLocalNotices(this.serverEntries) };
    // The host stamps the streaming entry's absolute index; translate it into the
    // window this client holds, and treat one below the window as not visible.
    const streamingIndex = event.patch.streamingAssistantIndex;
    const streamingLocal = streamingIndex === null ? null : streamingIndex - this.entriesFrom;
    this.snapshot = {
      session,
      busy: event.patch.busy,
      runningTurnId: event.patch.runningTurnId,
      pendingApproval: event.patch.pendingApproval,
      pendingApprovalId: event.patch.pendingApprovalId,
      pendingQuestion: event.patch.pendingQuestion ?? null,
      queuedMessageCount: event.patch.queuedMessageCount,
      firstQueuedMessage: event.patch.firstQueuedMessage,
      queuedMessages: event.patch.queuedMessages ?? (event.patch.firstQueuedMessage ? [event.patch.firstQueuedMessage] : []),
      sessionSaveError: event.patch.sessionSaveError,
      streamingAssistantEntry:
        streamingLocal === null || streamingLocal < 0 || streamingLocal >= this.serverEntries.length
          ? null
          : (this.serverEntries[streamingLocal] ?? null),
    };
    this.applyRuntime(event.patch.runtime);
    this.publish();
  }

  private applyRuntime(data: RuntimeViewData): void {
    Object.assign(this.runtime, {
      ...data,
      ...(data.approvalMode === 'ask' ? { approvalMode: 'workspace' } : {}),
    });
  }

  private addLocalNotice(error: unknown, tone: NoticeTone = 'error'): void {
    if (!this.snapshot || this.closed) return;
    const text = error instanceof Error ? error.message : String(error);
    const notice: SessionEntry = tone === 'info' ? { kind: 'notice', text } : { kind: 'notice', text, tone };
    this.localNotices.add(notice, this.totalEntries);
    this.scheduleLocalNoticeExpiry();
    const current = this.snapshot;
    this.snapshot = { ...current, session: { ...current.session, entries: this.localNotices.merge(this.serverEntries, this.entriesFrom) } };
    this.publish();
  }

  /** Re-publishes when the oldest notice passes its TTL, so it leaves on its own. */
  private scheduleLocalNoticeExpiry(): void {
    if (this.localNoticeTimer !== null || this.closed) return;
    this.localNoticeTimer = setTimeout(() => {
      this.localNoticeTimer = null;
      if (this.closed || !this.snapshot) return;
      if (this.localNotices.prune()) {
        this.snapshot = {
          ...this.snapshot,
          session: { ...this.snapshot.session, entries: this.localNotices.merge(this.serverEntries, this.entriesFrom) },
        };
        this.publish();
      }
      if (this.localNotices.length > 0) this.scheduleLocalNoticeExpiry();
    }, LOCAL_NOTICE_TTL_MS + 50);
    this.localNoticeTimer.unref?.();
  }

  /** Merged view: server entries with the live client-local notices in their place. */
  private withLocalNotices(entries: SessionEntry[]): SessionEntry[] {
    return this.localNotices.merge(entries, this.entriesFrom);
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  private handleClose(error: Error, socket: Socket = this.socket): void {
    if (socket !== this.socket) return;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (!this.closed && !this.connectionFailureReported && this.snapshot) {
      this.connectionFailureReported = true;
      this.addLocalNotice(
        this.intentionalShutdown
          ? 'The OpenButler host stopped. Run openbutler to connect again.'
          : 'Lost connection to the OpenButler host. Reconnecting…',
        this.intentionalShutdown ? 'error' : 'warn',
      );
    }
    if (!this.closed && !this.intentionalShutdown) void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closed || this.intentionalShutdown) return;
    this.reconnecting = true;
    const previousSessionId = this.snapshot?.session.id;
    // A windowed client may not hold the user message that proves a chat is real,
    // so read the denormalised flag the host stamps; fall back to a scan only for
    // an older host that never wrote it (and so sent the full transcript anyway).
    const previousSessionHadUserMessage =
      (this.snapshot?.session.hasUserMessage ?? this.snapshot?.session.entries.some((entry) => entry.kind === 'user')) === true;
    let attempt = 0;
    while (!this.closed && !this.intentionalShutdown) {
      let socket: Socket | null = null;
      try {
        socket = await connectSocket();
        if (this.closed || this.intentionalShutdown) {
          socket.destroy();
          break;
        }
        this.socket = socket;
        this.frames = new DaemonFrameDecoder(MAX_DAEMON_FRAME_BYTES);
        this.bindSocket(socket);
        await this.attach(this.attachOptions);

        const activeSessionHasMessages =
          (this.snapshot?.session.hasUserMessage ?? this.snapshot?.session.entries.some((entry) => entry.kind === 'user')) === true;
        if (
          previousSessionId &&
          previousSessionHadUserMessage &&
          this.attachOptions.scheduleId === undefined &&
          this.snapshot?.session.id !== previousSessionId &&
          !activeSessionHasMessages &&
          this.savedSessions.some((session) => session.id === previousSessionId)
        ) {
          const restored = await this.loadSession(previousSessionId);
          if (restored && this.snapshot) {
            // loadSession answers with the full transcript; keep only the window.
            const windowed = this.windowFull(restored.entries);
            this.serverEntries = windowed.entries;
            this.entriesFrom = windowed.from;
            this.totalEntries = windowed.total;
            this.snapshot = { ...this.snapshot, session: { ...restored, entries: this.withLocalNotices(windowed.entries) } };
            this.publish();
          }
        }

        this.connectionFailureReported = false;
        this.reconnecting = false;
        this.addLocalNotice('Reconnected to the OpenButler host.', 'info');
        return;
      } catch {
        if (socket && !socket.destroyed) socket.destroy();
        attempt++;
        if (this.closed || this.intentionalShutdown) break;
        await delay(Math.min(5_000, 250 * 2 ** Math.min(attempt, 5)));
      }
    }
    this.reconnecting = false;
  }
}

function snapshotFromData(data: SessionSnapshotData): AgentSessionSnapshot {
  const index = data.streamingAssistantIndex;
  return {
    session: data.session,
    busy: data.busy,
    runningTurnId: data.runningTurnId,
    pendingApproval: data.pendingApproval,
    pendingApprovalId: data.pendingApprovalId,
    pendingQuestion: data.pendingQuestion ?? null,
    queuedMessageCount: data.queuedMessageCount,
    firstQueuedMessage: data.firstQueuedMessage,
    queuedMessages: data.queuedMessages ?? (data.firstQueuedMessage ? [data.firstQueuedMessage] : []),
    sessionSaveError: data.sessionSaveError,
    streamingAssistantEntry: index === null ? null : (data.session.entries[index] ?? null),
  };
}

/**
 * The host's first-frame handshake on a remote socket: one `auth` frame out,
 * one verdict back, nothing else touched. A frame that is not the verdict is
 * pushed back into the stream so the session client binding next loses
 * nothing; the host sends nothing before the first request, so that path is a
 * safety net rather than an expected one.
 */
function performAuthHandshake(socket: Socket, token: string): Promise<void> {
  return new Promise((resolveHandshake, rejectHandshake) => {
    const decoder = new DaemonFrameDecoder(MAX_DAEMON_FRAME_BYTES);
    const id = randomUUID();
    const forwarded: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (error) {
        socket.destroy();
        rejectHandshake(error);
        return;
      }
      if (forwarded.length) socket.unshift(Buffer.concat(forwarded));
      resolveHandshake();
    };
    const timer = setTimeout(() => finish(new Error('Timed out authenticating to the OpenButler host.')), AUTH_HANDSHAKE_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      let messages: Buffer[];
      try {
        messages = decoder.append(chunk);
      } catch {
        finish(new Error('The host sent an oversized frame during authentication.'));
        return;
      }
      for (let index = 0; index < messages.length; index++) {
        const frame = messages[index]!;
        let message: unknown;
        try {
          message = JSON.parse(frame.toString('utf8'));
        } catch {
          forwarded.push(frame, Buffer.from('\n'));
          continue;
        }
        if (!isRecord(message) || message.id !== id || typeof message.ok !== 'boolean') {
          forwarded.push(frame, Buffer.from('\n'));
          continue;
        }
        if (!message.ok) {
          finish(new Error(typeof message.error === 'string' ? message.error : 'Authentication failed.'));
          return;
        }
        for (const rest of messages.slice(index + 1)) forwarded.push(rest, Buffer.from('\n'));
        finish();
        return;
      }
    };
    const onClose = () => finish(new Error('The host closed the connection during authentication.'));
    const onError = (error: Error) => finish(error);
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
    socket.write(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id, action: 'auth', token })}\n`);
  });
}

/**
 * The client half of pairing: one `pair` frame to a running backend, one
 * verdict back, and the minted token. The socket exists for the exchange
 * alone — the saved backend entry carries the token from then on, and this
 * rejects outright when nothing listens instead of waiting on a session.
 */
export function pairWithBackend(host: string, port: number, code: string): Promise<string> {
  return new Promise((resolvePair, rejectPair) => {
    const socket = createConnection({ host, port });
    const decoder = new DaemonFrameDecoder(MAX_DAEMON_FRAME_BYTES);
    const id = randomUUID();
    let settled = false;
    const finish = (error?: Error, token?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
      socket.destroy();
      if (error) rejectPair(error);
      else resolvePair(token as string);
    };
    const timer = setTimeout(
      () => finish(new Error(`Timed out pairing with ${host}:${port}. The host may not be listening, or the backend version differs.`)),
      AUTH_HANDSHAKE_TIMEOUT_MS,
    );
    const onData = (chunk: Buffer) => {
      let messages: Buffer[];
      try {
        messages = decoder.append(chunk);
      } catch {
        finish(new Error(`The backend at ${host}:${port} sent an oversized frame while pairing.`));
        return;
      }
      for (const frame of messages) {
        let verdict: unknown;
        try {
          verdict = JSON.parse(frame.toString('utf8'));
        } catch {
          continue;
        }
        if (!isRecord(verdict) || verdict.id !== id || typeof verdict.ok !== 'boolean') continue;
        if (!verdict.ok) {
          finish(new Error(typeof verdict.error === 'string' ? verdict.error : 'Pairing failed.'));
          return;
        }
        const result = verdict.result;
        if (!isRecord(result) || typeof result.token !== 'string' || !result.token.startsWith('obt_')) {
          finish(new Error(`The backend at ${host}:${port} did not return a usable pairing token.`));
          return;
        }
        finish(undefined, result.token);
        return;
      }
    };
    const onClose = () => finish(new Error(`The backend at ${host}:${port} closed the connection before pairing finished.`));
    const onError = (error: Error) => finish(error);
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id, action: 'pair', code })}\n`);
    });
  });
}

function connectSocket(): Promise<Socket> {
  // A saved backend moves this connection onto TCP; without one the endpoint
  // is unchanged, so an install that never wrote a registry behaves exactly
  // as before. Both the first connect and every reconnect go through here.
  const backend = resolveActiveBackend();
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = backend ? createConnection({ host: backend.host, port: backend.port }) : createConnection(getDaemonEndpoint());
    const timer = setTimeout(() => finish(new Error('Timed out connecting to the OpenButler host.')), CLIENT_CONNECT_TIMEOUT_MS);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      if (error) {
        socket.destroy();
        rejectSocket(error);
      } else resolveSocket(socket);
    };
    const onConnect = () => {
      // Only a backend entry with a token speaks the handshake; the local
      // pipe authenticates through the OS and sends its first frame as ever.
      if (backend?.token) {
        performAuthHandshake(socket, backend.token).then(
          () => finish(),
          (error: Error) => finish(error),
        );
        return;
      }
      finish();
    };
    const onError = (error: Error) => finish(error);
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function isAttachResult(value: unknown): value is AttachResult {
  return (
    isRecord(value) &&
    isSessionSnapshotData(value.snapshot) &&
    isRuntimeViewData(value.runtime) &&
    Array.isArray(value.savedSessions) &&
    (value.hostBuildId === undefined || value.hostBuildId === null || typeof value.hostBuildId === 'string') &&
    (value.clientKind === undefined || LOCAL_CLIENT_KINDS.some((kind) => kind === value.clientKind))
  );
}

function isSessionSnapshotData(value: unknown): value is SessionSnapshotData {
  return (
    isRecord(value) &&
    isRecord(value.session) &&
    Array.isArray(value.session.entries) &&
    typeof value.busy === 'boolean' &&
    (value.streamingAssistantIndex === null || Number.isSafeInteger(value.streamingAssistantIndex)) &&
    (value.entriesFrom === undefined ||
      (typeof value.entriesFrom === 'number' && Number.isSafeInteger(value.entriesFrom) && value.entriesFrom >= 0)) &&
    (value.totalEntries === undefined || Number.isSafeInteger(value.totalEntries))
  );
}

function isRuntimeViewData(value: unknown): value is RuntimeViewData {
  return (
    isRecord(value) &&
    typeof value.workspaceRoot === 'string' &&
    typeof value.modelName === 'string' &&
    (value.providerName === undefined || typeof value.providerName === 'string') &&
    typeof value.providerId === 'string' &&
    typeof value.modelId === 'string' &&
    (value.approvalMode === undefined ||
      value.approvalMode === 'ask' ||
      value.approvalMode === 'workspace' ||
      value.approvalMode === 'auto-review' ||
      value.approvalMode === 'full-access') &&
    Array.isArray(value.reasoningVariants)
  );
}

function isDaemonResponse(value: unknown): value is DaemonResponse {
  return (
    isRecord(value) &&
    value.version === DAEMON_PROTOCOL_VERSION &&
    typeof value.id === 'string' &&
    typeof value.ok === 'boolean' &&
    (value.ok ? 'result' in value : typeof value.error === 'string')
  );
}

function isDaemonEvent(value: unknown): value is DaemonEvent {
  if (!isRecord(value) || value.version !== DAEMON_PROTOCOL_VERSION) return false;
  if (value.event === 'notification') return typeof value.title === 'string' && typeof value.message === 'string';
  if (value.event === 'snapshot') return isSessionSnapshotData(value.snapshot) && isRuntimeViewData(value.runtime);
  if (value.event === 'patch') {
    return (
      isRecord(value.patch) &&
      isRecord(value.patch.session) &&
      isRuntimeViewData(value.patch.runtime) &&
      (value.patch.entriesPatch === undefined || isEntriesPatch(value.patch.entriesPatch))
    );
  }
  return false;
}

function isEntriesPatch(value: unknown): value is SessionEntriesPatch {
  if (!isRecord(value)) return false;
  if (value.kind === 'replace-all') return Array.isArray(value.entries);
  return value.kind === 'delta' && Array.isArray(value.append) && Array.isArray(value.replace) && Array.isArray(value.appendText);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
