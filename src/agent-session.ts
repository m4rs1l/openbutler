import { randomUUID } from 'node:crypto';
import { AGENT_BASE, type AgentBase } from './agent-instructions.js';
import { CUSTODIAN_SESSION_ID, sessionFilePath } from './session-paths.js';
import { bindSessionKeyRotation, RETRY_DELAYS_MS, type RetryEvent } from './provider/retry.js';
import type { JSONValue, LanguageModel, ModelMessage } from 'ai';
import type { CompactOutcome, CompactionResult } from './compaction.js';
import type { ToolActionUpdate } from './activity-ledger.js';
import type { StepUsageReport } from './agent.js';
import type { UsageRecordInput } from './usage/recorder.js';
import {
  compactionContextWindowTokens,
  createSession,
  listSavedSessions,
  loadSavedSession,
  saveSession,
  sessionTitle,
  type SavedSession,
  type SessionEntry,
  type SessionEntryMeta,
  type SessionSummary,
  type NoticeTone,
} from './session-store.js';
import { isToolRequestWhitelisted, rememberToolRequest } from './tool-permissions.js';
import { daemonCommandAction } from './commands/registry.js';
import { ensureHostOwnedRoots } from './host-owned-paths.js';
import { consumeApproval, recordDeniedAction } from './review-overrides.js';
import { resolveReasoningVariant, type ReasoningSupport, type ReasoningVariant } from './provider/registry.js';
import { geminiToolSchemaSanitizer } from './provider/gemini-schema.js';
import { isProviderCommand, runProviderCommand } from './provider/provider-command.js';
import { loadSettings, type ApprovalMode } from './settings.js';
import { autoReviewFingerprint, reviewToolRequest, type AutoReviewOptions, type AutoReviewResult } from './auto-review.js';
import type { ToolApprovalOutcome, ToolCallRequest, ToolRegistry, ToolUserQuestion } from './tools/registry.js';
import { ToolInputPreview } from './tool-preview.js';
import { classifySensitiveEntry, redactSensitive, redactSensitiveText } from './sensitive-data.js';
import { toolDisplayCommand as displayToolCommand } from './tool-display.js';
import { reportSessionActivity } from './session-registry.js';
import { sameReplyRoute, type TurnCommunication } from './communication.js';
import { isUnsupportedImageInputError, omitUnsupportedImageInputs } from './image.js';
import { attachmentReferences, storeAttachment, type FileAttachment } from './attachments.js';
import { decodeBase64Image, MAX_IMAGE_BYTES } from './image-data.js';
import type { ProjectContext } from './projects/types.js';
import { projectFolder, sessionProject, ProjectInputError } from './projects/store.js';

export type AgentProviderOptions = Record<string, Record<string, JSONValue>>;
export type ApprovalDecision = 'allow' | 'deny' | 'always';
export type AgentTurnProgress =
  | { kind: 'start' }
  | { kind: 'assistant-delta'; text: string }
  | { kind: 'tool-start'; tool: string }
  | { kind: 'tool-result'; tool: string; outcome: string };
export type AgentEventOutput = { kind: 'assistant'; text: string };
export type QueuedMessage = {
  /** Host-bound project facts, never accepted as raw IPC metadata. */
  projectContext?: ProjectContext;
  text: string;
  /** Legacy terminal wire input. Materialized to files before queue admission. */
  images: Array<{ base64: string; mediaType: 'image/png' }>;
  /** Host-owned file references, never accepted from IPC callers. */
  attachments?: FileAttachment[];
  eventId?: string;
  /** Host-only refresh at queue admission; null withdraws a stale notification. */
  beforeDelivery?: () => Promise<string | null>;
  /** Authenticated host facts, never accepted from client message payloads. */
  communication?: TurnCommunication;
  /** Host-only progress sink for transports that display a live turn. */
  onProgress?: (progress: AgentTurnProgress) => void;
  /** Host-bound filesystem and memory scope for this queued turn; never trusted from IPC input. */
  workspaceRoot?: string;
  /** Host-only trust labels for explicitly configured observer schedules; never accepted over TUI IPC. */
  reviewAuthorization?: { kind: 'schedule'; name: string; instruction: string; triggerFacts: unknown };
};

export interface AgentSessionRuntimeView {
  supportsSessionAttachments?: boolean;
  supportsProjects?: boolean;
  workspaceRoot: string;
  modelName: string;
  /** Readable provider name; absent until the host supplies one, so views fall back to providerId. */
  providerName?: string | undefined;
  providerId: string;
  modelId: string;
  contextWindowTokens: number | null;
  /** The head's configured compaction budget; absent means the identity default. */
  custodianContextLimitTokens?: number | undefined;
  supportsVision: boolean;
  reasoningVariants: ReasoningVariant[];
  reasoningMetadataSource: string | null;
  reasoningSupport: ReasoningSupport;
  reasoningDefault: string;
  saveReasoningPreference: (variantId: string) => void;
  showReasoningDefault: boolean;
  /** This provider's reasoning opens with a bold title line; views may headline it instead of a picked sentence. */
  reasoningTitles?: boolean;
  saveShowReasoningPreference: (visible: boolean) => void;
  /** Receives provider retry and key-rotation events; set per run, cleared after. */
  reportRetry?: (handler: ((event: RetryEvent) => void) | null) => void;
  approvalMode?: ApprovalMode;
  saveApprovalModePreference?: (mode: ApprovalMode) => void;
}

/**
 * The stored effort expressed in the levels a model offers.
 *
 * A level the model does not offer cannot stay the choice the picker shows, so
 * it is degraded to the nearest level below - never raised. The stored value
 * itself is kept by the caller, so switching back restores the choice.
 */
function remapEffort(variants: ReadonlyArray<{ id: string; label: string }>, stored: string): string {
  return resolveReasoningVariant(
    variants.map((variant) => ({ ...variant, providerOptions: {} })),
    stored,
  ).id;
}

export interface AgentEnvironment extends AgentSessionRuntimeView {
  model: LanguageModel;
  /** Model the permission reviewer runs on; unset means the main model. */
  reviewModel?: LanguageModel;
  /** Model chat titles are generated on; unset means the main model. */
  titleModel?: LanguageModel;
  /** Cheapest expressible reasoning options for title generation; absent with no title model. */
  getTitleProviderOptions?: () => ReasoningVariant['providerOptions'];
  outputLimitTokens: number | null;
  supportsImageToolResult: boolean;
  disableImageInput?: () => void;
  getReasoningProviderOptions: (variantId: string, visible: boolean) => ReasoningVariant['providerOptions'];
  /** Cheapest expressible reasoning options for permission reviews; live with model switches. */
  getReviewProviderOptions: () => ReasoningVariant['providerOptions'];
  registry: ToolRegistry;
  getPeerCapabilities?: () => { platform: string; mcpServers: Array<{ name: string; toolCount: number }>; mcpTools: string[] };
  selectWorkspaceRoot?: (workspaceRoot: string) => Promise<void>;
  /** Accounting sink; absent when nothing owns a ledger (tests, one-off runs). */
  recordUsage?: (input: UsageRecordInput, id: string) => void;

  selectModel: (providerId: string, modelId: string) => Promise<void>;
  /** Activate a saved conversation's model without changing global defaults. */
  restoreModel?: (providerId: string, modelId: string) => Promise<void>;
  /** Connect deferred tools before capturing the first turn's tool catalogue. */
  prepareForTurn?: () => Promise<void>;
  /** Refresh model credentials/options at request boundaries; reconnect tools only when all shared sessions are idle. */
  reloadSettings?: (reloadTools?: boolean) => Promise<void>;
  close: () => Promise<void>;
}

export type AgentSessionView = Omit<SavedSession, 'conversation' | 'conversationArchive'>;

export interface AgentSessionSnapshot {
  session: AgentSessionView;
  busy: boolean;
  /**
   * The transcript turn the running work writes into: null while the run has
   * not placed its message yet and while no run is active. Clients must not
   * guess the live turn from `busy` and list position - a run is marked busy
   * before its message reaches the transcript, and that window used to light
   * up the previous turn.
   */
  runningTurnId: string | null;
  pendingApproval: ToolCallRequest | null;
  pendingApprovalId: string | null;
  pendingQuestion: { id: string; question: string; options: string[] | null } | null;
  queuedMessageCount: number;
  firstQueuedMessage: { text: string; imageCount: number } | null;
  queuedMessages: { id?: string; text: string; imageCount: number; editable?: boolean; steering?: boolean }[];
  sessionSaveError: string | null;
  streamingAssistantEntry: SessionEntry | null;
}

export interface AgentTurnPreferences {
  reasoningVariantId: string;
  showReasoning: boolean;
}

type QueuedTurn = {
  id: string;
  automatic: boolean;
  /** Only explicit owner steering and host notifications may enter a live run. */
  steering: boolean;
  message: QueuedMessage;
  preferences: AgentTurnPreferences;
  resolve: () => void;
  reject: (error: unknown) => void;
  /** The owner message already has a transcript entry; the turn only delivers it to the model. */
  entryAdded?: boolean;
  turnId?: string | undefined;
};

export type AgentEventRunResult = { error: string | null; outputs: AgentEventOutput[]; replyHandledByEventId?: string; skipped?: boolean };

export interface AgentSessionOptions {
  onAutomaticWakeReady?: () => void;
  onSessionSaved?: (session: SavedSession) => void;
  /**
   * Host-only: one bounded line naming the reports that arrived during this run.
   * A projection, not a message: it reaches the model's next step and never the
   * transcript, and the inbox record stays unread so the head can open it in
   * full. The line must change only when what is waiting changed, because a run
   * injects each distinct line once.
   */
  pendingReports?: () => string | null;
  /** Background-policy run: no interactive question channel and no tool-level self-approval. */
  background?: boolean;
  /**
   * The base this session is built for: its text and its role. Omitted means the
   * neutral agent base; the custodian and a worker each pass their own, which is
   * the base of their prompt rather than a note appended to the agent's.
   */
  basePolicy?: AgentBase;
  autoApprove?: (request: ToolCallRequest) => boolean;
  autoReviewer?: (options: AutoReviewOptions) => Promise<AutoReviewResult>;
  /**
   * Tools this session owns instead of the runtime's whole registry. The host
   * materialises `tools` into this registry, so a capability the session was not
   * granted is missing from its toolkit rather than refused when it tries.
   */
  registry?: ToolRegistry;
  /** The tool names granted to this session; the host turns them into `registry`. */
  tools?: readonly string[];
  /** Worker write lease check (subagent sessions only): refused writes name the worker holding the file. */
  writeGuard?: (sessionId: string, path: string) => string | null;
  /** null stores a machine-wide custodian session without assigning it to one workspace. */
  sessionWorkspaceRoot?: string | null;
}

export interface AgentSessionClient {
  readonly runtime: AgentSessionRuntimeView;
  /** The host process's launch entry, when the transport carried one. */
  readonly hostEntry?: string | null;
  getSnapshot: () => AgentSessionSnapshot;
  /**
   * The transcript as the host sent it, without the notices this client shows on
   * its own. Index-addressed consumers (the web server's patches) must use this:
   * a local notice sits inside the merged snapshot, so indices taken from there
   * point at the wrong entries the moment one arrives or expires.
   */
  getServerEntries: () => readonly SessionEntry[];
  subscribe: (listener: () => void) => () => void;
  readonly isBusy: boolean;
  addEntry(entry: SessionEntry): void;
  approveToolCall(decision: ApprovalDecision, requestId?: string): void;
  answerQuestion(answer: string | null, questionId?: string): void;
  stop(options?: { keepQueue?: boolean; holdQueue?: boolean }): void;
  sendMessage(message: QueuedMessage, preferences: AgentTurnPreferences): Promise<void>;
  compact(preferences: AgentTurnPreferences, recovery?: boolean): Promise<void>;
  selectModel(providerId: string, modelId: string): Promise<void>;
  /**
   * Records the effort for THIS chat. The machine default in settings.yaml is
   * never touched, so another chat keeps running its own choice and the two
   * surfaces cannot disagree about what a chat runs with.
   */
  setReasoningPreference(variantId: string): void | Promise<void>;
  setApprovalMode(mode: ApprovalMode): Promise<void>;
  listSessions(): SessionSummary[] | Promise<SessionSummary[]>;
  loadSession(id: string): SavedSession | AgentSessionView | null | Promise<SavedSession | AgentSessionView | null>;
  createNewSession(projectId?: string | null): void | Promise<void>;
  selectProject?(projectId: string | null, sessionId: string): void | Promise<void>;
  manageQueuedMessage?(id: string, action: 'steer' | 'remove', sessionId: string): void | Promise<void>;
  /**
   * Runs a registry command (`/compact`, `/new`, `/stop`) on this session.
   * Optional like `manageQueuedMessage`: a client built against an older host
   * has no way to carry one, and the caller reports that instead of guessing.
   */
  command?(name: string, payload?: Record<string, unknown>): Promise<void>;
  flushSave(): void | Promise<void>;
  close(): void | Promise<void>;
}

const STREAM_RENDER_INTERVAL_MS = 50;
/**
 * Shutdown waits for a run to settle, but a provider that ignores abort must not
 * be able to hold the host open: after this bound the controller still flushes
 * and closes, and the abandoned stream is left to its own abort handling.
 */
const CLOSE_IDLE_TIMEOUT_MS = 5_000;
/**
 * How long a manual approval prompt waits for a human decision when nothing
 * is configured. Expiry denies the action but never stops the run, so an
 * unattended agent keeps working instead of hanging on a prompt nobody sees.
 */
const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 120;

/**
 * A transcript written before the duration stamp fixed the reasoning entry
 * carries the compaction's thinking without its marker: the rebuild used to
 * drop `internal` when it added durationMs. The reader attaches compaction
 * output by provenance alone now, so the lost marker is restored here, once,
 * when the session opens - between the compaction row and its checkpoint,
 * nowhere else.
 */
function stampCompactionOutput(entries: SessionEntry[]): SessionEntry[] {
  let insideCompaction = false;
  return entries.map((entry) => {
    if (entry.kind === 'compaction') {
      insideCompaction = true;
      return entry;
    }
    if (!insideCompaction) return entry;
    if (entry.kind === 'reasoning' && entry.internal === undefined) return { ...entry, internal: 'compaction' };
    insideCompaction = false;
    return entry;
  });
}

/** Owns conversation/session state and runs independently of any terminal UI. */
export class AgentSessionController implements AgentSessionClient {
  private session: SavedSession;
  private conversation: ModelMessage[] = [];
  private conversationArchive: ModelMessage[] = [];
  /**
   * The system prompt, built once and reused byte-for-byte for the life of a
   * session so the provider's prefix cache always hits. It is rebuilt only
   * through `refreshSystemPrompt`: at a scope change (session, workspace,
   * provider or model) and after a compaction's summary has landed. A rebuild
   * never precedes a request that could still reuse the cached prefix.
   */
  private frozenSystem: { key: string; text: string } | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly queuedMessages: QueuedTurn[] = [];
  /** Id of the user message whose turn is currently producing entries. */
  private activeTurnId: string | undefined;
  /** Owner message currently executing; steering must target its route and scope. */
  private activeSteeringMessage: QueuedMessage | null = null;
  /**
   * Set by an Esc-style stop: queued messages are kept visible in the chat but
   * never start a run on their own. The next explicit send releases the hold
   * and the held messages run together with it. Plain and keepQueue stops do
   * not set this; only a stop that passes `holdQueue` does.
   */
  private queueHold = false;
  private readonly eventRunResults = new Map<string, AgentEventRunResult>();
  private activeEventOutputs: AgentEventOutput[] | null = null;
  private activeEventAssistantText = '';
  private activeTurnProgress: QueuedMessage['onProgress'];
  private readonly pendingStreamDeltas: Array<{ kind: 'assistant' | 'reasoning'; text: string; internal?: 'compaction' }> = [];
  private busy = false;
  /** The turn a standalone compaction writes its row into; null outside one. */
  private compactionTurnId: string | null = null;
  private closed = false;
  private titleAbort: AbortController | null = null;
  /**
   * A compaction requested while a run was in flight. The run serves it at its
   * next step boundary; the run's end is only the fallback for a request that
   * arrives after the last step.
   */
  private pendingCompaction: { preferences: AgentTurnPreferences; recovery: boolean; scopeRoot?: string } | null = null;
  private pendingApproval: ToolCallRequest | null = null;
  private pendingApprovalId: string | null = null;
  private approvalResolver: ((decision: ApprovalDecision) => void) | null = null;
  private pendingQuestion: { id: string; question: string; options: string[] | null } | null = null;
  private questionResolver: ((answer: string | null) => void) | null = null;
  private autoReviewConsecutiveDenials = 0;
  private autoReviewRecentDenials: boolean[] = [];
  private readonly autoReviewDeniedFingerprints = new Map<string, string>();
  private readonly autoReviewAllowedFingerprints = new Set<string>();
  private currentReviewAuthorization: QueuedMessage['reviewAuthorization'] | null = null;
  private currentReviewMessages: ModelMessage[] = [];
  private activeRunAbort: AbortController | null = null;
  private lastContextUsage: number | undefined;
  private lastContextEstimate: number | undefined;
  private sessionHasUserMessage = false;
  private latestSessionSnapshot: SavedSession | null = null;
  private sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Persistable content of the last successful save or open; a navigation that matches it writes nothing. */
  private lastPersistedContent: string | null = null;
  /** The model/effort choice on record, so a choice made before any message still counts as a change. */
  private lastPersistedChoice: string | null = null;
  private sessionSaveError: string | null = null;
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private streamedAssistantEntry: SessionEntry | null = null;
  private streamedReasoningEntry: SessionEntry | null = null;
  /** The compaction row currently on screen, so its state can be updated in place. */
  private compactionEntry: Extract<SessionEntry, { kind: 'compaction' }> | null = null;
  /**
   * The one notice a retry sequence owns. Each further attempt replaces this
   * entry in place instead of appending a line per second, and the entry stays
   * in the transcript after the sequence ends, so a slow turn explains itself.
   */
  private retryNotice: SessionEntry | null = null;

  /** Turns a provider retry or key rotation into that single updating line. */
  private reportModelRetry(event: RetryEvent): void {
    const cause = describeRetryCause(event.error);
    const text =
      event.kind === 'retry'
        ? `${cause}. Retry ${event.attempt + 1} of ${RETRY_DELAYS_MS.length} in ${Math.max(1, Math.round(event.waitMs / 1000))}s.`
        : `${cause}. ${event.reason === 'auth' ? 'Key rejected' : 'Retries exhausted'}, switching to the next key.`;
    const next: SessionEntry = { kind: 'notice', text, tone: 'warn' };
    const previous = this.retryNotice;
    if (previous) this.replaceEntry(previous, next);
    else this.addEntry(next);
    this.retryNotice = next;
  }

  /** A response arrived, so the next retry belongs to a new line. */
  private closeRetryNotice(): void {
    this.retryNotice = null;
  }

  /** When the current reasoning block started, for the duration it reports. */
  private reasoningStartedAt: number | null = null;
  private runningToolEntry: { request: ToolCallRequest; entry: Extract<SessionEntry, { kind: 'tool' }> } | null = null;
  private readonly previewToolEntries = new Map<
    string,
    {
      entry: Extract<SessionEntry, { kind: 'tool' }>;
      preview: ToolInputPreview;
      providerId: string;
      name: string;
    }
  >();
  private snapshot: AgentSessionSnapshot;
  private activeEventId: string | undefined;
  private runError: string | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(
    readonly runtime: AgentEnvironment,
    private readonly recordAction?: (action: ToolActionUpdate) => void | Promise<void>,
    private readonly options: AgentSessionOptions = {},
  ) {
    // Every session (foreground, background, worker) provisions the host-owned
    // roots first, so the dated scratch directory exists before the first
    // tool call classifies against it. Best-effort by design; see
    // ensureHostOwnedRoots.
    ensureHostOwnedRoots();
    this.session = createSession(
      runtime.providerId,
      runtime.modelId,
      runtime.contextWindowTokens ?? undefined,
      this.sessionWorkspaceScope ?? undefined,
    );
    this.lastContextUsage = this.session.contextTokens;
    this.lastContextEstimate = this.session.contextEstimateTokens;
    this.lastPersistedChoice = this.persistableChoiceKey(this.session);
    // A chat announces its model and effort from the state it opens in, so a
    // pick made before the first message is marked above that message.
    this.resetAnnouncementBaseline();
    this.snapshot = this.makeSnapshot();
  }

  getSnapshot = (): AgentSessionSnapshot => this.snapshot;
  private sessionModel(model: LanguageModel = this.runtime.model): LanguageModel {
    return bindSessionKeyRotation(model, (this.session.keyPositions ??= {}));
  }
  /** The provider-boundary schema rebuild for this run's model, absent where no strict subset applies. */
  private toolSchemaSanitizer(): ((schema: Record<string, unknown>) => Record<string, unknown>) | undefined {
    return geminiToolSchemaSanitizer(this.sessionModel());
  }
  /** The controller has no client-local notices, so both views are the same. */
  getServerEntries = (): readonly SessionEntry[] => this.snapshot.session.entries;
  get isBusy(): boolean {
    return this.busy;
  }
  get automaticWakeHeld(): boolean {
    return this.session.automaticWakeHeld === true;
  }
  getLastRunError(): string | null {
    return this.runError;
  }

  takeEventRunResult(eventId: string): AgentEventRunResult | null {
    const result = this.eventRunResults.get(eventId) ?? null;
    this.eventRunResults.delete(eventId);
    return result;
  }

  private get sessionWorkspaceScope(): string | null {
    return this.options.sessionWorkspaceRoot === undefined ? this.runtime.workspaceRoot : this.options.sessionWorkspaceRoot;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private makeSnapshot(): AgentSessionSnapshot {
    // A held turn whose entry already sits in the transcript is not "queued" from
    // the owner's point of view; counting it twice would show the same text twice.
    const pending = this.queuedMessages.filter((turn) => !turn.entryAdded);
    const queuedMessages = pending.map((turn) => ({
      id: turn.id,
      text: turn.message.text,
      imageCount: messageImageCount(turn.message),
      editable: !turn.automatic,
      steering: turn.steering,
    }));
    const first = queuedMessages[0] ?? null;
    const { conversation, conversationArchive, ...session } = this.session;
    void conversation;
    void conversationArchive;
    return {
      session: { ...session, hasUserMessage: this.sessionHasUserMessage },
      busy: this.busy,
      // A standalone compaction has no running turn: it is a boundary, not work.
      // Lighting `compactionTurnId` up here re-opened the finished turn and made
      // its timer count again while the checkpoint was being written. A run that
      // compacts mid-turn still reports its own real turn.
      runningTurnId: this.busy ? (this.activeTurnId ?? null) : null,
      pendingApproval: this.pendingApproval,
      pendingApprovalId: this.pendingApprovalId,
      pendingQuestion: this.pendingQuestion,
      queuedMessageCount: pending.length,
      firstQueuedMessage: first,
      queuedMessages,
      sessionSaveError: this.sessionSaveError,
      streamingAssistantEntry: this.streamedAssistantEntry,
    };
  }

  private publish(scheduleSave = true): void {
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
    if (scheduleSave) this.scheduleSave();
  }

  private scheduleSave(): void {
    this.latestSessionSnapshot = this.persistableSession();
    if (this.sessionSaveTimer !== null) return;
    // A model/effort choice is worth keeping on its own: a chat configured before its
    // first message must not reopen on some older model.
    if (!this.session.entries.some((entry) => entry.kind === 'user') && !this.choiceChanged(this.latestSessionSnapshot)) return;
    this.sessionSaveTimer = setTimeout(
      () => {
        this.sessionSaveTimer = null;
        this.persistLatest();
      },
      this.busy ? 1_000 : 400,
    );
  }

  private persistableSession(): SavedSession {
    return {
      ...this.session,
      title: this.session.title === 'New session' ? sessionTitle(this.session.entries) : this.session.title,
      updatedAt: new Date().toISOString(),
      // Saved sessions own their model selection. Runtime state may have been
      // initialized from the global default before this session was restored.
      providerId: this.session.providerId,
      modelId: this.session.modelId,
      conversation: this.conversation,
      ...(this.conversationArchive.length > 0 ? { conversationArchive: this.conversationArchive } : {}),
    };
  }

  /** The content a save would write, with the write timestamp normalised away. */
  private persistableContentKey(): string {
    return JSON.stringify({ ...this.persistableSession(), updatedAt: '' });
  }

  /** The model/effort choice alone: a chat can be configured before it has a single message. */
  private persistableChoiceKey(session: SavedSession): string {
    return JSON.stringify([session.providerId, session.modelId, session.reasoning ?? null, session.reasoningVariants ?? null]);
  }

  private choiceChanged(session: SavedSession): boolean {
    return this.lastPersistedChoice !== null && this.persistableChoiceKey(session) !== this.lastPersistedChoice;
  }

  /**
   * Conversation content changed - a message landed or a turn finished. The
   * recent lists order by this stamp, so navigation must never touch it.
   */
  private touchActivity(): void {
    this.session = { ...this.session, lastActivityAt: new Date().toISOString() };
  }

  private persistLatest(allowEmpty = false): void {
    const latest = this.latestSessionSnapshot;
    if (!latest) return;
    const hasUserMessage = latest.entries.some((entry) => entry.kind === 'user');
    const choiceMoved = this.choiceChanged(latest);
    if (!allowEmpty && !hasUserMessage && !choiceMoved) return;
    // Opening or switching conversations carries no content change; rewriting
    // the file there would move the chat in every recent list without a reason.
    const key = JSON.stringify({ ...latest, updatedAt: '' });
    if (key === this.lastPersistedContent) return;
    try {
      // An empty chat is written only because its choice changed; the chat list
      // already hides records without a user message, so nothing new surfaces.
      this.session = saveSession(latest, { allowEmpty: allowEmpty || !hasUserMessage });
      this.lastPersistedContent = this.persistableContentKey();
      this.lastPersistedChoice = this.persistableChoiceKey(latest);
      this.options.onSessionSaved?.(this.session);
      this.sessionSaveError = null;
    } catch (error) {
      this.sessionSaveError = error instanceof Error ? error.message : String(error);
    }
    this.publish(false);
  }

  flushSave(options: { allowEmpty?: boolean } = {}): void {
    if (this.sessionSaveTimer !== null) clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = null;
    this.latestSessionSnapshot = this.persistableSession();
    this.persistLatest(options.allowEmpty === true);
  }

  addEntry(entry: SessionEntry): void {
    // Stamp in place: tool and streaming bookkeeping look entries up by object
    // identity, so replacing the object here would silently detach them.
    const stamped = entry as SessionEntryMeta & SessionEntry;
    if (stamped.at === undefined) stamped.at = Date.now();
    if (stamped.turnId === undefined && this.activeTurnId !== undefined) stamped.turnId = this.activeTurnId;
    this.session = { ...this.session, entries: [...this.session.entries, stamped] };
    if (stamped.kind === 'user') this.touchActivity();
    this.publish();
  }

  private replaceEntry(previous: SessionEntry, next: SessionEntry): void {
    const index = this.session.entries.indexOf(previous);
    if (index < 0) return;
    // A replacement keeps the entry's origin: grouping and timing must not move
    // just because the row was rewritten (streaming text, tool result).
    const stamped = next as SessionEntryMeta & SessionEntry;
    if (stamped.at === undefined) stamped.at = previous.at;
    if (stamped.turnId === undefined) stamped.turnId = previous.turnId;
    const entries = [...this.session.entries];
    entries[index] = stamped;
    this.session = { ...this.session, entries };
    this.publish();
  }

  addNotice(text: string, tone: NoticeTone = 'info', cause?: string): void {
    // Info stays unmarked so persisted transcripts keep the established shape;
    // `cause` is written only when the notice classifies a failure, so a plain
    // statement never grows a band it cannot explain.
    const extra = { ...(tone === 'info' ? {} : { tone }), ...(cause === undefined ? {} : { cause }) };
    this.addEntry({ kind: 'notice', text, ...extra });
  }

  /** A transcript boundary the backend owns: settings changes and day breaks. */
  private addDivider(text: string): void {
    this.addEntry({ kind: 'divider', text });
  }

  private reasoningLabel(variantId: string): string {
    // The label belongs to the model THIS chat runs with: its own recorded
    // levels first, the shared runtime's list only when this chat has none.
    // After a model change the runtime's list is already the new model's, and
    // an effort the new model does not offer would lose its readable name and
    // be reported as a bare id.
    const levels = this.session.reasoningVariants?.length ? this.session.reasoningVariants : this.runtime.reasoningVariants;
    return levels.find((variant) => variant.id === variantId)?.label ?? variantId;
  }

  /**
   * The baseline the transcript announces against: the model and the effort
   * this chat runs with at this moment. It is taken when the chat opens, not
   * at its first message, so a pick made before any message still gets marked
   * above that message instead of being silently absorbed.
   */
  private resetAnnouncementBaseline(): void {
    this.announcedEffort = this.sessionReasoning();
    this.announcedEffortLabel = this.reasoningLabel(this.announcedEffort);
    this.announcedModel = this.session.modelId ?? this.runtime.modelId;
  }

  /**
   * The effort this session runs with: its own recorded choice when the owner
   * has picked one in this chat, else the machine default. The session is the
   * authority; the runtime value is only the fallback for a chat that never chose.
   */
  private sessionReasoning(): string {
    return this.session.reasoning ?? this.runtime.reasoningDefault;
  }

  /** The session's reasoning-visibility choice, with the machine default as fallback. */
  private sessionShowReasoning(): boolean {
    return this.session.showReasoning ?? this.runtime.showReasoningDefault;
  }

  /**
   * Record the effort the next request will actually use. An idle change lands
   * at message admission; a mid-run change lands at its first consumption.
   * The label is written once per change, so repeated requests stay quiet.
   */
  private announceEffortChange(): void {
    const current = this.sessionReasoning();
    if (current === this.announcedEffort) return;
    if (this.announcedEffort !== null)
      this.addDivider(
        `Reasoning effort changed from "${this.announcedEffortLabel ?? this.reasoningLabel(this.announcedEffort)}" to "${this.reasoningLabel(current)}"`,
      );
    this.announcedEffort = current;
    this.announcedEffortLabel = this.reasoningLabel(current);
  }

  /**
   * A model switch reads as a boundary above the first message that runs with
   * it. The pick alone changes no request, so it must not split the transcript;
   * and a chat with no message yet names nothing, because there is no earlier
   * model to say it changed from.
   */
  private announceModelChange(): void {
    const current = this.session.modelId;
    if (current === this.announcedModel) return;
    if (this.announcedModel !== null) this.addDivider(`Model changed from "${this.announcedModel}" to "${current}"`);
    this.announcedModel = current;
  }

  /**
   * Day boundary above the next message. Only the moment is stored; the shared
   * divider label turns it into Today/Yesterday/weekday at read time, so the
   * same entry reads correctly on later days in every client.
   */
  private ensureTimeDivider(): void {
    const now = new Date();
    let last: number | undefined;
    for (let index = this.session.entries.length - 1; index >= 0; index--) {
      const at = this.session.entries[index]!.at;
      if (at !== undefined) {
        last = at;
        break;
      }
    }
    // Nothing precedes a first message, so there is no boundary to draw: an empty
    // transcript opens without a day divider instead of inventing one at now.
    if (last === undefined) return;
    if (new Date(last).toDateString() === now.toDateString()) return;
    this.addEntry({ kind: 'divider' });
  }

  listSessions(): SessionSummary[] {
    return listSavedSessions(this.sessionWorkspaceScope);
  }

  loadSession(id: string): SavedSession | null {
    const session = loadSavedSession(id, this.sessionWorkspaceScope);
    if (session) this.openSession(session);
    return session;
  }

  openSession(session: SavedSession): void {
    if (this.busy) return;
    if (session.id !== this.session.id) this.cancelTitleGeneration();
    this.flushSave();
    this.session = {
      ...session,
      keyPositions: session.keyPositions ?? {},
      entries: stampCompactionOutput(
        session.entries.map((entry) => {
          if (entry.kind !== 'tool' || entry.toolTitle !== undefined || !entry.tool) return entry;
          const title = this.runtime.registry.getDisplayTitle(entry.tool);
          return title !== undefined ? { ...entry, toolTitle: title } : entry;
        }),
      ),
      ...(session.workspaceRoot === undefined && typeof this.sessionWorkspaceScope === 'string'
        ? { workspaceRoot: this.sessionWorkspaceScope }
        : {}),
    };
    this.conversation = [...session.conversation];
    this.conversationArchive = [...(session.conversationArchive ?? [])];
    this.refreshSystemPrompt();
    this.lastContextUsage = session.contextTokens;
    this.lastContextEstimate = session.contextEstimateTokens;
    this.sessionHasUserMessage = session.entries.some((entry) => entry.kind === 'user');
    // Content is clean on open: a pure navigation must never rewrite the file.
    this.lastPersistedContent = this.persistableContentKey();
    this.lastPersistedChoice = this.persistableChoiceKey(this.session);
    this.pendingApproval = null;
    this.pendingApprovalId = null;
    this.streamedAssistantEntry = null;
    this.streamedReasoningEntry = null;
    // Each session announces its own model and effort from the state it opens
    // in: a pick made before the first message must still be marked above
    // that message, so the baseline is taken here and not at the first message.
    this.resetAnnouncementBaseline();
    this.runningToolEntry = null;
    this.currentReviewAuthorization = null;
    this.currentReviewMessages = [];
    this.publish();
  }

  selectProject(projectId: string | null, sessionId: string): void {
    if (sessionId !== this.session.id) throw new ProjectInputError('The active chat changed. Try again.');
    if (this.sessionHasUserMessage || this.session.project?.locked || this.queuedMessages.some((turn) => !turn.automatic))
      throw new ProjectInputError("This chat's project was fixed by its first message. Start a new chat.");
    if (this.busy) throw new ProjectInputError('Wait for the running task to finish before choosing a project.');
    // No file write: a chat whose first message has not landed is not a store
    // entry. The binding stays in memory and is persisted with that message.
    // Without a project the chat runs where the runtime already points: the scope it was
    // opened in. The session-record scope cannot answer this, because a chat's record is
    // deliberately unstamped.
    this.session = saveSession({ ...this.session, project: sessionProject(projectId, this.runtime.workspaceRoot) });
    this.publish(false);
  }

  createNewSession(projectId?: string | null): void {
    if (this.busy) return;
    // The custodian is one fixed session; a new chat belongs to the normal chat
    // layer, so this controller never replaces its own record.
    if (this.session.id === CUSTODIAN_SESSION_ID) throw new Error('The custodian session is fixed; new chats open in the chat layer.');
    const project = projectId === undefined ? undefined : sessionProject(projectId, this.runtime.workspaceRoot);
    this.cancelTitleGeneration();
    this.flushSave();
    this.session = {
      ...createSession(
        this.runtime.providerId,
        this.runtime.modelId,
        this.runtime.contextWindowTokens ?? undefined,
        this.sessionWorkspaceScope ?? undefined,
      ),
      // A new chat opens on the effort it is being opened from; a chat that
      // never chose keeps following the machine default.
      ...(this.session.reasoning === undefined ? {} : { reasoning: this.session.reasoning }),
      ...(this.session.showReasoning === undefined ? {} : { showReasoning: this.session.showReasoning }),
    };
    if (project) this.session = saveSession({ ...this.session, project });
    this.conversation = [];
    this.conversationArchive = [];
    this.refreshSystemPrompt();
    this.lastContextUsage = undefined;
    this.lastContextEstimate = undefined;
    this.sessionHasUserMessage = false;
    // A new chat announces against the state it opens in, not against the
    // previous chat's last announcement: the baseline belongs to this chat.
    this.resetAnnouncementBaseline();
    this.lastPersistedChoice = this.persistableChoiceKey(this.session);
    this.pendingApproval = null;
    this.pendingApprovalId = null;
    this.streamedAssistantEntry = null;
    this.streamedReasoningEntry = null;
    this.runningToolEntry = null;
    this.currentReviewAuthorization = null;
    this.currentReviewMessages = [];
    this.publish();
  }

  /**
   * Starts the machine custodian on a machine that has none: an internal session at
   * the reserved id, belonging to no chat list. Its compaction budget comes from that
   * id rather than from the record, so nothing written on a session can re-tune it.
   * The host calls it only from the custodian surface, and only when the reserved
   * record is absent, so the identity is the id itself and no marker or pointer is
   * needed to recognize it later. The file is written even though the record is still
   * empty: the machine must own its session on disk from the moment the host starts.
   */
  startCustodianSession(): void {
    const record = saveSession(
      {
        ...createSession(
          this.runtime.providerId,
          this.runtime.modelId,
          this.runtime.contextWindowTokens ?? undefined,
          this.sessionWorkspaceScope ?? undefined,
        ),
        id: CUSTODIAN_SESSION_ID,
      },
      { allowEmpty: true },
    );
    this.openSession(record);
  }

  /** The compaction row becomes `failed` in place, keeping its start size; a later attempt appends its own row. */
  private failRunningCompaction(): void {
    this.flushStreamedEntries();
    const started = this.compactionEntry;
    this.compactionEntry = null;
    if (started)
      this.replaceEntry(started, {
        kind: 'compaction',
        status: 'failed',
        ...(started.beforeTokens === undefined ? {} : { beforeTokens: started.beforeTokens }),
      });
  }

  /** An actionable transcript line for a refusal — numbers and the exact fix, never a dead end. */
  private compactionRefusalNotice(refusal: Extract<CompactOutcome, { kind: 'impossible' }>): string {
    if (refusal.reason === 'no-reduction')
      return 'Compaction was skipped: the checkpoint would not shrink the active context, so it was not applied. The turn continues with the original context.';
    return (
      `Compaction does not fit the budget: the conversation needs about ${refusal.estimatedTokens} tokens but the configured window is ${refusal.window} tokens, so the summarization request itself would overflow by ${refusal.shortfallTokens} tokens. ` +
      `Raise providers.${this.runtime.providerId}.modelSpecs.${this.runtime.modelId}.context in settings above the conversation size, or remove it to use the catalog value, or start a new chat with /new. ` +
      (refusal.cause ? `The sliced fallback tried first and stopped: ${refusal.cause}. ` : '') +
      'The turn continues with the original context.'
    );
  }

  /**
   * The same refusal classified as a stable band — `compaction:<reason>` — so tooling can
   * group failures without parsing the prose notice for near-identical numbers.
   */
  private compactionRefusalCause(refusal: Extract<CompactOutcome, { kind: 'impossible' }>): string {
    return `compaction:${refusal.reason}`;
  }

  private effectiveContextWindowTokensForCompaction(): number | null {
    return compactionContextWindowTokens(
      this.session.id,
      this.runtime.contextWindowTokens,
      this.lastContextUsage ?? this.lastContextEstimate,
      this.runtime.custodianContextLimitTokens,
    );
  }

  async restoreSessionModel(): Promise<void> {
    // The runtime now matches this chat again, so its list is this chat's list.
    // A model picked while a run was going becomes real here, at the turn
    // boundary, and the chat's effort is re-mapped onto that model's levels:
    // an effort the new model does not offer cannot stay the choice it shows.
    if (this.runtime.providerId !== this.session.providerId || this.runtime.modelId !== this.session.modelId) {
      if (!this.runtime.restoreModel) throw new Error('This runtime cannot restore the saved session model.');
      await this.runtime.restoreModel(this.session.providerId, this.session.modelId);
    }
    if (this.runtime.reasoningVariants.length > 0) {
      const variants = this.runtime.reasoningVariants.map(({ id, label }) => ({ id, label }));
      this.session = {
        ...this.session,
        reasoningVariants: variants,
        ...(this.session.reasoning !== undefined ? { reasoning: remapEffort(variants, this.session.reasoning) } : {}),
      };
    }
    this.publish();
  }

  /**
   * Records the model this chat runs with.
   *
   * A pick is accepted at any moment, including while a run is going: it is
   * recorded here and takes effect at the next turn boundary, never in the
   * middle of a running request. The host hands over the target model's own
   * effort levels, so the picker answers with the levels of the model this
   * chat will run with next.
   */
  async selectModel(providerId: string, modelId: string, pendingVariants?: ReadonlyArray<{ id: string; label: string }>): Promise<void> {
    const sameModel = modelId === this.session.modelId;
    // While a run is going the shared runtime belongs to that turn: switching
    // it now would move the model under the running request. The pick waits
    // for the turn boundary, where restoreSessionModel() activates it.
    if (!this.busy) await this.runtime.selectModel(providerId, modelId);
    // No divider here on purpose: the switch is a choice, not a message. The
    // transcript records it above the first message that runs with it, which is
    // where a reader can tell what the following request was made with.
    // A provider change for the same model must not replace measured usage with a smaller byte estimate.
    if (!sameModel) {
      this.lastContextUsage = undefined;
      this.lastContextEstimate = undefined;
    }
    // The levels belong to a model, not to a runtime. The host hands over the
    // target model's own levels; without them the running model's list would
    // be recorded and the picker would offer levels the new model refuses.
    const variants =
      pendingVariants && pendingVariants.length > 0
        ? pendingVariants.map(({ id, label }) => ({ id, label }))
        : this.runtime.reasoningVariants.map(({ id, label }) => ({ id, label }));
    this.session = {
      ...this.session,
      providerId,
      modelId,
      // The runtime is shared, so its list belongs to whichever session last
      // activated a model. Recording this chat's own list here is what lets the
      // picker answer for the model this chat reports, even while another chat
      // has the runtime bound to a different one.
      ...(variants.length > 0 ? { reasoningVariants: variants } : {}),
      ...(this.runtime.contextWindowTokens === null ? {} : { contextWindowTokens: this.runtime.contextWindowTokens }),
    };
    if (!sameModel) {
      delete this.session.contextTokens;
      delete this.session.contextEstimateTokens;
      // The chat's own effort is RE-MAPPED onto the new model's levels, never
      // dropped: a dropped choice falls back to the machine default, so the
      // chat silently changes how it runs and the picker shows an effort the
      // owner never picked.
      if (this.session.reasoning !== undefined && variants.length > 0)
        this.session = { ...this.session, reasoning: remapEffort(variants, this.session.reasoning) };
    }
    if (this.runtime.contextWindowTokens === null) delete this.session.contextWindowTokens;
    this.publish();
  }

  /**
   * Records the effort for THIS session only. It persists with the chat and
   * survives restarts; the machine default in settings.yaml is never touched,
   * so another session keeps running its own choice.
   */
  setReasoningPreference(variantId: string): void {
    if (this.session.reasoning === variantId) return;
    this.session = { ...this.session, reasoning: variantId };
    this.publish();
  }

  /** Records the reasoning-visibility toggle for THIS session only. */
  setShowReasoningPreference(visible: boolean): void {
    if (this.session.showReasoning === visible) return;
    this.session = { ...this.session, showReasoning: visible };
    this.publish();
  }

  async setApprovalMode(mode: ApprovalMode): Promise<void> {
    if (!this.runtime.saveApprovalModePreference) throw new Error('Permission settings are unavailable.');
    await this.runtime.saveApprovalModePreference(mode);
    this.publish();
  }

  approveToolCall(decision: ApprovalDecision, requestId = this.pendingApprovalId): void {
    if (!this.pendingApproval || !this.pendingApprovalId || requestId !== this.pendingApprovalId) return;
    const resolve = this.approvalResolver;
    const request = this.pendingApproval;
    this.approvalResolver = null;
    this.pendingApproval = null;
    this.pendingApprovalId = null;
    this.publish();
    if (!resolve || !request) return;
    if (decision !== 'deny') this.autoReviewConsecutiveDenials = 0;
    if (decision === 'always') {
      try {
        rememberToolRequest(this.runtime.workspaceRoot, request);
      } catch (error) {
        this.addNotice(
          `Could not save the allowlist; this request will be allowed once. ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        );
      }
    }
    resolve(decision);
  }

  answerQuestion(answer: string | null, questionId = this.pendingQuestion?.id): void {
    if (!this.pendingQuestion || questionId !== this.pendingQuestion.id) return;
    const resolve = this.questionResolver;
    this.questionResolver = null;
    this.pendingQuestion = null;
    this.publish();
    resolve?.(answer);
  }

  /**
   * Stops the current work. By default queued messages are dropped too (a plain
   * stop); `keepQueue` keeps them and they start automatically in a fresh turn
   * (the owner's `/stop` semantics); `holdQueue` implies `keepQueue` and additionally
   * holds them back so they stay visible in the chat without starting a run on
   * their own (the TUI's Esc semantics). The hold is released by the next
   * explicit send, which runs the held messages together with the new one.
   */
  stop(options: { keepQueue?: boolean; holdQueue?: boolean; preserveWakePolicy?: boolean } = {}): void {
    if (!options.preserveWakePolicy) this.session = { ...this.session, automaticWakeHeld: true };
    if (options.holdQueue === true) {
      this.queueHold = true;
      // Land the run's buffered stream deltas under ITS turn before the held
      // message mints a new one, keep `activeTurnId` aimed at the running turn
      // while the held entries materialise (addUserEntry regenerates it per
      // held message), and only then abort. Anything the settling run flushes
      // afterwards must not inherit a held message's turn id, and must not
      // write below a message that never ran.
      this.flushStreamedEntries();
      const runningTurnId = this.activeTurnId;
      this.materializeHeldTurns();
      this.activeTurnId = runningTurnId;
    } else if (options.keepQueue !== true) {
      for (const turn of this.queuedMessages.splice(0)) turn.reject(new Error('Run cancelled before execution.'));
    }
    this.activeRunAbort?.abort();
    if (this.pendingQuestion) this.answerQuestion(null);
    if (this.pendingApproval) this.approveToolCall('deny');
    else this.publish();
  }

  /**
   * The registry's dispatch for a caller holding this controller instead of a
   * transport: the same name-to-effect mapping the daemon applies to
   * `session.command` over IPC, so one name cannot mean two things.
   */
  async command(name: string, payload: Record<string, unknown> = {}): Promise<void> {
    const action = daemonCommandAction(name);
    if (action === 'session.compact') {
      // The surface passes turn preferences through untouched; refuse anything
      // malformed here rather than let it reach a compaction request.
      const turn = payload.preferences as Partial<AgentTurnPreferences> | null | undefined;
      if (
        !turn ||
        typeof turn.reasoningVariantId !== 'string' ||
        turn.reasoningVariantId.length > 256 ||
        typeof turn.showReasoning !== 'boolean'
      )
        throw new Error('turn preferences are invalid.');
      await this.compact({ reasoningVariantId: turn.reasoningVariantId, showReasoning: turn.showReasoning }, payload.recovery === true);
      return;
    }
    if (action === 'session.new') {
      const projectId = payload.projectId;
      if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') throw new Error('Invalid project ID.');
      await this.createNewSession(projectId as string | null | undefined);
      return;
    }
    if (action === 'session.stop') {
      this.stop({
        ...(payload.keepQueue === true ? { keepQueue: true as const } : {}),
        ...(payload.holdQueue === true ? { holdQueue: true as const } : {}),
      });
      return;
    }
    throw new Error('Unknown command.');
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeSession();
    return this.closePromise;
  }

  private async closeSession(): Promise<void> {
    this.closed = true;
    this.cancelTitleGeneration();
    this.stop({ preserveWakePolicy: true });
    this.flushStreamedEntries();
    this.flushSave();
    await this.waitUntilIdle(CLOSE_IDLE_TIMEOUT_MS);
    this.flushStreamedEntries();
    if (this.streamFlushTimer !== null) clearTimeout(this.streamFlushTimer);
    this.streamFlushTimer = null;
    this.flushSave();
  }

  waitUntilIdle(timeoutMs?: number): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolveIdle) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = this.subscribe(() => {
        if (this.busy) return;
        if (timer !== null) clearTimeout(timer);
        unsubscribe();
        resolveIdle();
      });
      if (timeoutMs !== undefined)
        timer = setTimeout(() => {
          unsubscribe();
          resolveIdle();
        }, timeoutMs);
    });
  }

  private appendStreamedText(delta: string, internal?: 'compaction'): void {
    // Assistant text ends the thinking block, so its duration is stamped first.
    this.finishStreamedReasoning();
    // A response arrived: any retry line belongs to a finished sequence.
    this.closeRetryNotice();
    const previous = this.streamedAssistantEntry;
    // The marker belongs to the text that produced it and follows the entry as it
    // grows, so one checkpoint stays one entry from its first token to its last.
    const tag = internal ?? (previous?.kind === 'assistant' ? previous.internal : undefined);
    const marked = tag === undefined ? {} : { internal: tag };
    if (previous?.kind === 'assistant') {
      const next: SessionEntry = { kind: 'assistant', text: previous.text + delta, ...marked };
      this.streamedAssistantEntry = next;
      this.replaceEntry(previous, next);
    } else {
      // addEntry stamps the active run's turn; a standalone compaction has none,
      // so its checkpoint names the compaction turn explicitly instead of being
      // placed by array position alone.
      const checkpointTurn = tag === 'compaction' ? this.compactionTurn() : undefined;
      const entry: SessionEntry = {
        kind: 'assistant',
        text: delta,
        ...marked,
        ...(checkpointTurn === undefined ? {} : { turnId: checkpointTurn }),
      };
      this.streamedAssistantEntry = entry;
      this.addEntry(entry);
    }
  }

  private appendStreamedReasoning(delta: string, internal?: 'compaction'): void {
    if (!delta) return;
    this.closeRetryNotice();
    const previous = this.streamedReasoningEntry;
    const tag = internal ?? (previous?.kind === 'reasoning' ? previous.internal : undefined);
    const marked = tag === undefined ? {} : { internal: tag };
    if (previous?.kind === 'reasoning') {
      const next: SessionEntry = {
        kind: 'reasoning',
        text: previous.text + delta,
        ...(previous.durationMs === undefined ? {} : { durationMs: previous.durationMs }),
        ...marked,
      };
      this.streamedReasoningEntry = next;
      this.replaceEntry(previous, next);
    } else {
      // Stamped here as well as in addEntry: this path inserts straight into the
      // list, and an entry without a turn id can only be placed by array
      // position — one misplacement and the thought lands in another turn.
      const entry = { kind: 'reasoning', text: delta, ...marked } as SessionEntryMeta & SessionEntry;
      if (entry.at === undefined) entry.at = Date.now();
      // A standalone compaction runs without an active run, so its thinking names
      // the compaction turn too: position alone would split it from its row the
      // moment a message arrives while the compaction is still writing.
      const owner = tag === 'compaction' ? this.compactionTurn() : this.activeTurnId;
      if (entry.turnId === undefined && typeof owner === 'string') entry.turnId = owner;
      this.streamedReasoningEntry = entry;
      this.reasoningStartedAt = Date.now();
      const assistantIndex = this.streamedAssistantEntry ? this.session.entries.indexOf(this.streamedAssistantEntry) : -1;
      const entries = [...this.session.entries];
      entries.splice(assistantIndex < 0 ? entries.length : assistantIndex, 0, entry);
      this.session = { ...this.session, entries };
      this.publish();
    }
  }

  /**
   * Stamps how long the model actually spent thinking on the current block, so
   * the transcript can say "Thought for 13.2s". Called wherever the block ends:
   * the next assistant token, a tool call, or the end of the run.
   */
  private finishStreamedReasoning(): void {
    const entry = this.streamedReasoningEntry;
    this.streamedReasoningEntry = null;
    const startedAt = this.reasoningStartedAt;
    this.reasoningStartedAt = null;
    if (entry?.kind !== 'reasoning' || startedAt === null || entry.durationMs !== undefined) return;
    const next: SessionEntry = {
      kind: 'reasoning',
      text: entry.text,
      durationMs: Math.max(0, Date.now() - startedAt),
      // The stamp rewrites the row, so provenance has to survive it: without this
      // a compaction's thinking becomes ordinary work as soon as its text starts,
      // which is what put the checkpoint's reasoning between the boundary row and
      // the checkpoint it belongs to.
      ...(entry.internal === undefined ? {} : { internal: entry.internal }),
    };
    this.replaceEntry(entry, next);
  }

  private queueStreamDelta(kind: 'assistant' | 'reasoning', text: string, internal?: 'compaction'): void {
    if (!text) return;
    const last = this.pendingStreamDeltas[this.pendingStreamDeltas.length - 1];
    // Deltas merge only within the same provenance: a checkpoint token must never
    // join the answer that follows it, or the marker would leak into the reply.
    if (last?.kind === kind && last.internal === internal) last.text += text;
    else this.pendingStreamDeltas.push({ kind, text, ...(internal === undefined ? {} : { internal }) });
    if (this.streamFlushTimer === null) {
      // A repaint batch keeps the current message open; tool/run boundaries finish it.
      this.streamFlushTimer = setTimeout(() => this.flushStreamedDeltas(), STREAM_RENDER_INTERVAL_MS);
    }
  }

  /** The admitted turn's own message preferences; cleared when the run settles. */
  private activeTurnPreferences: AgentTurnPreferences | null = null;
  /** Last effort announced in the transcript; null until the first admission pins it. */
  private announcedEffort: string | null = null;
  /**
   * The label the announced effort carried when it was announced. A later model
   * may no longer offer that level, and the raw id would then read as a second
   * kind of name next to the new level's label.
   */
  private announcedEffortLabel: string | null = null;
  /** Last model announced in the transcript; null until the first admission pins it. */
  private announcedModel: string | null = null;
  private showReasoningAtTurnStart = true;

  /**
   * Turn preferences as they are right now. The admitted turn's message owns
   * them and keeps them for its whole life: an effort changed while the turn
   * runs belongs to the NEXT turn, which is where the transcript announces it.
   * Moving the ground under a request that is already in flight is what made
   * a chat answer with an effort nobody picked.
   */
  private liveTurnPreferences(): AgentTurnPreferences {
    const turn = this.activeTurnPreferences;
    if (!turn)
      return {
        reasoningVariantId: this.sessionReasoning(),
        showReasoning: this.sessionShowReasoning(),
      };
    const visibilityChanged = this.sessionShowReasoning() !== this.showReasoningAtTurnStart;
    return {
      reasoningVariantId: turn.reasoningVariantId,
      showReasoning: visibilityChanged ? this.sessionShowReasoning() : turn.showReasoning,
    };
  }

  /**
   * The session's frozen system prompt, built on first use and reused verbatim
   * afterwards. The cache key covers the three things a rebuild is mandatory
   * for: workspace, provider/model and session. The remaining refresh point -
   * after a compaction's summary - belongs to `refreshSystemPrompt`, never to
   * this function: rebuilding in front of a request that could reuse the cached
   * prefix is what makes the largest request of a session miss.
   */
  private frozenSystemPrompt(build: (workspaceRoot: string, basePolicy?: AgentBase) => string): string {
    const key = `${this.runtime.workspaceRoot}\u0000${this.runtime.providerId}\u0000${this.runtime.modelId}\u0000${this.session.id}`;
    if (this.frozenSystem?.key !== key) {
      this.frozenSystem = { key, text: build(this.runtime.workspaceRoot, this.options.basePolicy) };
    }
    return this.frozenSystem.text;
  }

  /**
   * Drops the frozen prompt so the next run rebuilds the reference block from
   * disk (memory index, skills, user context, team identity).
   *
   * Ordering is the contract, not an optimization: this runs only after a
   * compaction's summary has landed, where the conversation rewrite has already
   * killed the message prefix, so the re-read costs one system read instead of a
   * miss on every later turn. Inside the running turn the request keeps the
   * string it started with, so the refresh lands at the next run and never in
   * front of the compaction request itself.
   */
  private refreshSystemPrompt(): void {
    this.frozenSystem = null;
  }

  /** The provider says the reasoning block is over: flush and stamp it once. */
  private endStreamedReasoning(): void {
    this.flushStreamedDeltas();
    this.finishStreamedReasoning();
  }

  private flushStreamedDeltas(): void {
    if (this.streamFlushTimer !== null) clearTimeout(this.streamFlushTimer);
    this.streamFlushTimer = null;
    for (const delta of this.pendingStreamDeltas.splice(0)) {
      if (delta.kind === 'assistant') this.appendStreamedText(delta.text, delta.internal);
      else this.appendStreamedReasoning(delta.text, delta.internal);
    }
  }

  private flushStreamedEntries(): void {
    this.flushStreamedDeltas();
    // A reasoning block usually ends here: a tool call, a step boundary or the
    // end of the run. Its duration has to be stamped before the pointer drops,
    // otherwise every block that is not followed by assistant text keeps a bare
    // "Thought" label forever.
    this.finishStreamedReasoning();
    const wasStreaming = this.streamedAssistantEntry !== null;
    this.streamedAssistantEntry = null;
    if (wasStreaming) this.publish();
  }

  private onToolStart(request: ToolCallRequest, toolCallId?: string): void {
    this.flushEventAssistantText();
    this.flushStreamedEntries();
    const input = toolDisplayInput(request.input);
    this.reportTurnProgress({ kind: 'tool-start', tool: toolIdentity(request) });
    const tool = toolIdentity(request);
    const preview = toolCallId ? this.previewToolEntries.get(toolCallId) : undefined;
    if (preview) {
      this.previewToolEntries.delete(toolCallId!);
      const entry: Extract<SessionEntry, { kind: 'tool' }> = {
        kind: 'tool',
        input,
        result: '',
        running: true,
        tool,
        ...(request.title !== undefined ? { toolTitle: request.title } : {}),
      };
      this.runningToolEntry = { request, entry };
      this.replaceEntry(preview.entry, entry);
      return;
    }
    const entry: Extract<SessionEntry, { kind: 'tool' }> = {
      kind: 'tool',
      input,
      result: '',
      running: true,
      tool,
      ...(request.title !== undefined ? { toolTitle: request.title } : {}),
    };
    this.runningToolEntry = { request, entry };
    this.addEntry(entry);
  }

  private onToolResult(request: ToolCallRequest, value: unknown, toolCallId?: string): void {
    this.flushEventAssistantText();
    this.flushStreamedEntries();
    const formatted = formatToolResult(request, value);
    this.reportTurnProgress({ kind: 'tool-result', tool: toolIdentity(request), outcome: formatted.outcome });
    const tool = toolIdentity(request);
    const workerSession = workerSessionId(request, value);
    const running = this.runningToolEntry;
    if (running?.request === request) {
      this.runningToolEntry = null;
      this.replaceEntry(running.entry, {
        kind: 'tool',
        input: running.entry.input ?? toolDisplayInput(request.input),
        result: formatted.text || 'No output',
        running: false,
        tool,
        ...(request.title !== undefined ? { toolTitle: request.title } : {}),
        ...(running.entry.at === undefined ? {} : { durationMs: Date.now() - running.entry.at }),
        ...(workerSession === undefined ? {} : { session: workerSession }),
      });
      return;
    }
    const preview = toolCallId ? this.previewToolEntries.get(toolCallId) : undefined;
    if (preview) {
      this.previewToolEntries.delete(toolCallId!);
      this.replaceEntry(preview.entry, {
        kind: 'tool',
        input: toolDisplayInput(request.input),
        result: formatted.text || 'No output',
        tool,
        ...(request.title !== undefined ? { toolTitle: request.title } : {}),
        ...(preview.entry.at === undefined ? {} : { durationMs: Date.now() - preview.entry.at }),
        ...(workerSession === undefined ? {} : { session: workerSession }),
      });
      return;
    }
    this.addEntry({
      kind: 'tool',
      input: toolDisplayInput(request.input),
      result: formatted.text || 'No output',
      tool,
      ...(request.title !== undefined ? { toolTitle: request.title } : {}),
      ...(workerSession === undefined ? {} : { session: workerSession }),
    });
  }

  private onToolPreviewStart(info: { toolCallId: string; providerId: string; name: string; title?: string }): void {
    // Commit buffered text but keep the assistant message open: providers can keep streaming text
    // after a tool call begins, and it belongs to the same message. Closing here split it in two.
    this.flushStreamedDeltas();
    // The provider already said the reasoning block ended; stamp it before the
    // tool input keeps streaming, or the thought stays open until the call executes.
    this.finishStreamedReasoning();
    const entry: Extract<SessionEntry, { kind: 'tool' }> = {
      kind: 'tool',
      command: info.title ?? toolDisplayName(info.providerId, info.name),
      ...(info.title !== undefined ? { toolTitle: info.title } : {}),
      result: '',
      preparing: true,
      tool: toolIdentity(info),
    };
    this.previewToolEntries.set(info.toolCallId, { entry, preview: new ToolInputPreview(), providerId: info.providerId, name: info.name });
    this.addEntry(entry);
  }

  private onToolPreviewDelta(info: { toolCallId: string; inputTextDelta: string }): void {
    const preview = this.previewToolEntries.get(info.toolCallId);
    if (!preview) return;
    preview.preview.push(info.inputTextDelta);
    const command = toolPreviewCommand(preview.providerId, preview.name, preview.preview.fields, preview.entry.toolTitle);
    const previous = preview.entry;
    if (command === previous.command) return;
    const entry: Extract<SessionEntry, { kind: 'tool' }> = { ...previous, command };
    preview.entry = entry;
    this.replaceEntry(previous, entry);
  }

  private onToolPreviewAvailable(info: { toolCallId: string; input: Record<string, unknown> }): void {
    const preview = this.previewToolEntries.get(info.toolCallId);
    if (!preview) return;
    const previous = preview.entry;
    const input = toolDisplayInput(info.input);
    const { command: _preview, ...rest } = previous;
    const entry: Extract<SessionEntry, { kind: 'tool' }> = { ...rest, input };
    preview.entry = entry;
    this.replaceEntry(previous, entry);
  }

  /** A call that never reached `execute` stays visible as a settled, non-running entry. */
  private settleToolPreviews(): void {
    if (this.previewToolEntries.size === 0) return;
    for (const preview of this.previewToolEntries.values()) {
      this.replaceEntry(preview.entry, {
        ...preview.entry,
        kind: 'tool',
        result: 'The tool call was not executed.',
        preparing: false,
        running: false,
        ...(preview.entry.tool ? { tool: preview.entry.tool } : {}),
      });
    }
    this.previewToolEntries.clear();
  }

  private async requestApproval(request: ToolCallRequest, signal?: AbortSignal): Promise<boolean | ToolApprovalOutcome> {
    if (signal?.aborted) return false;
    const approvalMode = this.runtime.approvalMode ?? 'workspace';
    if (approvalMode === 'full-access') return true;
    if (approvalMode === 'auto-review') {
      if (this.isAutoReviewCircuitOpen()) {
        this.addNotice('Auto-review paused after repeated denials. This action needs your approval.', 'warn');
        await this.recordAutoReviewState(request, 'review_unavailable', { code: 'circuit-open', status: 'circuit-open' });
        return this.requestManualApproval(request);
      }

      const fingerprint = autoReviewFingerprint(request);
      // A one-time user approval beats the same-turn denial memory: the retry
      // still goes through review, with the override visible to the reviewer.
      const override = consumeApproval(this.runtime.workspaceRoot, request);
      if (override) this.addNotice(`Retrying ${request.providerId}/${request.name} with your one-time approval…`);
      const previousDenial = !override ? this.autoReviewDeniedFingerprints.get(fingerprint) : undefined;
      if (previousDenial) {
        this.recordAutoReviewDenial(true);
        const reason = `The same exact action was already denied in this turn. Previous reason: ${previousDenial}`;
        await this.recordAutoReviewState(request, 'reviewed', {
          reviewer: 'auto-review',
          verdict: 'deny',
          confidence: 'high',
          risk: 'unknown',
          reason,
          repeated: true,
        });
        this.addNotice(`Auto-review denied a repeated tool request: ${previousDenial}`, 'warn');
        return { approved: false, source: 'auto-review', reason };
      }

      // One status row per review: it starts as "checking" and is replaced in
      // place when the review decides, so the transcript never shows a stale
      // check. Pressing it (mouse) reveals the recorded reason and assessment.
      const checking: SessionEntry = { kind: 'notice', text: `Auto-review is checking ${request.providerId}/${request.name}…` };
      this.addEntry(checking);
      const settleReviewStatus = (text: string, detail: string) => this.replaceEntry(checking, { kind: 'notice', text, detail });
      const decisionDetail = (decision: { confidence: string; risk: string; authority?: string; reason: string }) =>
        `${decision.reason}\nRisk: ${decision.risk} · Confidence: ${decision.confidence}${decision.authority ? ` · Authority: ${decision.authority}` : ''}`;
      // Read fresh so a `openbutler permissions --review-timeout` change applies without a host restart.
      const reviewTimeoutSeconds = loadSettings().autoReviewTimeoutSeconds;
      // The review is a classification call: it never inherits the turn's
      // reasoning effort, so a heavy thinking setup cannot slow every
      // permission check into a timeout.
      // An identical action already allowed in this turn is not reviewed
      // again, but only when repeating it cannot change anything outside the
      // model: reads whose result stays inside the session. Anything that
      // writes, executes, or reaches another party is reviewed every time.
      const repeatableRead =
        request.effect.change === 'none' && (request.effect.outbound === 'none' || request.effect.outbound === 'model');
      if (repeatableRead && this.autoReviewAllowedFingerprints.has(fingerprint)) {
        const reason = 'The identical side-effect-free action was already allowed in this turn.';
        await this.recordAutoReviewState(request, 'reviewed', {
          reviewer: 'auto-review',
          verdict: 'allow',
          confidence: 'high',
          risk: 'low',
          reason,
          repeated: true,
        });
        settleReviewStatus(
          `Auto-review checked ${request.providerId}/${request.name}: allow · low risk`,
          `${reason}\nRisk: low · Confidence: high`,
        );
        return { approved: true, source: 'auto-review', reason, risk: 'low' };
      }
      let outcome: AutoReviewResult;
      try {
        await this.runtime.reloadSettings?.();
        outcome = await (this.options.autoReviewer ?? reviewToolRequest)({
          model: this.sessionModel(this.runtime.reviewModel ?? this.runtime.model),
          request,
          messages: [...this.currentReviewMessages],
          workspaceRoot: this.runtime.workspaceRoot,
          providerOptions: this.runtime.getReviewProviderOptions(),
          ...(request.gateReason ? { gateReason: request.gateReason } : {}),
          ...(override ? { userOverride: true } : {}),
          ...(reviewTimeoutSeconds === undefined ? {} : { timeoutMs: reviewTimeoutSeconds * 1000 }),
          ...(this.currentReviewAuthorization ? { authorizedSchedule: this.currentReviewAuthorization } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        outcome = {
          status: 'unavailable',
          code: 'model-error',
          reason: `Auto-review failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (signal?.aborted || outcome.status === 'cancelled') return false;
      if (autoReviewFingerprint(request) !== fingerprint) {
        outcome = { status: 'unavailable', code: 'changed-during-review', reason: 'The pending action changed during review.' };
      }

      if (outcome.status === 'unavailable') {
        this.recordAutoReviewDenial(false);
        const reason = String(outcome.reason).slice(0, 500);
        await this.recordAutoReviewState(request, 'review_unavailable', { reviewer: 'auto-review', code: outcome.code, reason });
        settleReviewStatus(`Auto-review checked ${request.providerId}/${request.name}: needs your approval`, `${outcome.code}: ${reason}`);
        return this.requestManualApproval(request);
      }

      const { decision } = outcome;
      await this.recordAutoReviewState(request, 'reviewed', {
        reviewer: 'auto-review',
        providerId: this.runtime.providerId,
        modelId: this.runtime.modelId,
        verdict: decision.verdict,
        confidence: decision.confidence,
        risk: decision.risk,
        authority: decision.authority,
        reason: decision.reason,
        ...(override ? { override: true } : {}),
      });
      if (decision.verdict === 'allow') {
        this.recordAutoReviewDenial(false);
        if (repeatableRead) this.autoReviewAllowedFingerprints.add(fingerprint);
        settleReviewStatus(
          `Auto-review checked ${request.providerId}/${request.name}: allow · ${decision.risk} risk`,
          decisionDetail(decision),
        );
        return { approved: true, source: 'auto-review', reason: decision.reason, risk: decision.risk };
      }
      if (decision.verdict === 'deny') {
        this.recordAutoReviewDenial(true);
        this.autoReviewDeniedFingerprints.set(fingerprint, decision.reason);
        recordDeniedAction(this.runtime.workspaceRoot, request, decision.reason);
        settleReviewStatus(`Auto-review checked ${request.providerId}/${request.name}: denied`, decisionDetail(decision));
        return { approved: false, source: 'auto-review', reason: decision.reason };
      }

      this.recordAutoReviewDenial(false);
      settleReviewStatus(`Auto-review checked ${request.providerId}/${request.name}: needs your approval`, decisionDetail(decision));
      return this.requestManualApproval(request);
    }
    return this.requestManualApproval(request);
  }

  private requestManualApproval(request: ToolCallRequest): Promise<boolean | ToolApprovalOutcome> {
    // Read fresh so a `openbutler permissions --approval-timeout` change applies without a host restart.
    const timeoutSeconds = loadSettings().approvalTimeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS;
    return new Promise<boolean | ToolApprovalOutcome>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Drop the prompt everywhere: a later click finds no pending approval and no-ops.
        this.approvalResolver = null;
        this.pendingApproval = null;
        this.pendingApprovalId = null;
        this.addNotice(`No approval decision within ${timeoutSeconds} seconds; the action was not run.`, 'warn');
        this.publish();
        resolve({
          approved: false,
          source: 'approval-timeout',
          reason: `Nobody approved or declined within ${timeoutSeconds} seconds.`,
          timeoutSeconds,
        });
      }, timeoutSeconds * 1000);
      timer.unref?.();
      this.approvalResolver = (decision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(decision !== 'deny');
      };
      this.pendingApproval = request;
      this.pendingApprovalId = request.requestId;
      this.publish();
    });
  }

  /**
   * Presents a model question to the user and resolves with the answer, or null
   * when the question is dismissed or the run stops. Unattended runs have no
   * channel; the question tool reports that to the model instead of hanging.
   */
  private requestQuestion(question: ToolUserQuestion, signal?: AbortSignal): Promise<string | null> {
    if (this.options.background === true) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      const id = `question-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this.questionResolver = (answer) => resolve(answer);
      this.pendingQuestion = { id, question: question.text, options: question.options ? [...question.options] : null };
      this.publish();
    });
  }

  /**
   * Records an auto-review verdict.
   *
   * `reviewed` and `review_unavailable` annotate a pending request; they are not
   * one of the gating transitions — `proposed`, `approved`, `started` — that must
   * be durable before execution continues. So a ledger failure here is surfaced to
   * the session and the decision still proceeds. Otherwise a bookkeeping problem
   * silently becomes a denial the user never sees and never chose.
   */
  private async recordAutoReviewState(
    request: ToolCallRequest,
    state: 'reviewed' | 'review_unavailable',
    result: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.recordAction?.({
        requestId: request.requestId,
        workspaceRoot: this.runtime.workspaceRoot,
        sessionId: this.session.id,
        ...(this.activeEventId ? { eventId: this.activeEventId } : {}),
        providerId: request.providerId,
        name: request.name,
        input: request.input,
        effect: request.effect,
        state,
        result,
      });
    } catch (error) {
      this.addNotice(
        `The activity ledger could not record the auto-review verdict (${state}): ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      );
    }
  }

  private recordAutoReviewDenial(denied: boolean): void {
    this.autoReviewRecentDenials.push(denied);
    if (this.autoReviewRecentDenials.length > 50) this.autoReviewRecentDenials.shift();
    this.autoReviewConsecutiveDenials = denied ? this.autoReviewConsecutiveDenials + 1 : 0;
  }

  private isAutoReviewCircuitOpen(): boolean {
    return this.autoReviewConsecutiveDenials >= 3 || this.autoReviewRecentDenials.filter(Boolean).length >= 10;
  }

  private resetAutoReviewTurn(): void {
    this.autoReviewConsecutiveDenials = 0;
    this.autoReviewRecentDenials = [];
    this.autoReviewDeniedFingerprints.clear();
    this.autoReviewAllowedFingerprints.clear();
  }

  private reportTurnProgress(progress: AgentTurnProgress): void {
    try {
      this.activeTurnProgress?.(progress);
    } catch {
      // A transport preview must never interrupt the agent turn.
    }
  }

  private flushEventAssistantText(): void {
    const text = this.activeEventAssistantText;
    this.activeEventAssistantText = '';
    if (text.trim()) this.activeEventOutputs?.push({ kind: 'assistant', text });
  }

  /**
   * An Esc hold keeps the queued owner messages pending, but the owner expects to
   * see them in the transcript right away. Materialise each one exactly once: the
   * entry appears in the chat, while the turn still waits for the next explicit
   * send before it reaches the model.
   */
  private materializeHeldTurns(): void {
    let added = false;
    for (const turn of this.queuedMessages) {
      if (this.materializeHeldTurn(turn)) added = true;
    }
    if (added) this.publish();
  }

  /**
   * Land one held turn in the chat exactly once. The transcript entry must not
   * steal the running turn's identity: `addUserEntry` regenerates `activeTurnId`
   * per held message, so the run's id is saved and restored around it — a run
   * that is still settling must keep flushing into its own turn.
   */
  private materializeHeldTurn(turn: QueuedTurn): boolean {
    if (turn.automatic || turn.entryAdded) return false;
    const runningTurnId = this.activeTurnId;
    turn.entryAdded = true;
    this.addUserEntry(turn.message);
    turn.turnId = this.activeTurnId;
    this.activeTurnId = runningTurnId;
    return true;
  }

  private addUserEntry(message: QueuedMessage, steering = false): void {
    // The transcript keeps why the next request looks different: the day this
    // message opens and the effort it will actually run with. Both land above
    // the message, while no turn id is assigned yet.
    this.ensureTimeDivider();
    this.announceModelChange();
    this.announceEffortChange();
    if (!steering || !this.activeTurnId) this.activeTurnId = randomUUID();
    this.addEntry({
      kind: 'user',
      text: message.text,
      ...(message.workspaceRoot ? { workspaceRoot: message.workspaceRoot } : {}),
      ...(messageImageCount(message) > 0 ? { imageCount: messageImageCount(message) } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(message.communication ? { source: message.communication.source } : {}),
      ...(message.eventId ? { eventId: message.eventId } : {}),
    });
  }

  private finishTurn(turnId: string | undefined, cancelled: boolean): void {
    if (!turnId) return;
    const entry = this.session.entries.find((entry) => entry.kind === 'user' && entry.turnId === turnId);
    if (entry)
      this.replaceEntry(entry, {
        ...entry,
        turnOutcome: cancelled ? 'cancelled' : this.runError ? 'failed' : 'completed',
        turnEndedAt: Date.now(),
      });
  }

  /**
   * The turn compaction output belongs to: the running turn when a step
   * boundary compacted mid-run, otherwise the turn the transcript ends in.
   */
  private compactionTurn(): string | undefined {
    return this.activeTurnId ?? this.compactionTurnId ?? undefined;
  }

  /** The turn the transcript currently ends in; a standalone compaction row lands there. */
  private lastTranscriptTurnId(): string | null {
    for (let index = this.session.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.session.entries[index]!;
      if (entry.kind === 'user') return entry.turnId ?? null;
    }
    return null;
  }

  sendMessage(message: QueuedMessage, preferences: AgentTurnPreferences): Promise<void> {
    return this.enqueueMessage(message, preferences, false);
  }

  /** Automatic wake-ups share the normal queue but never release an owner's stop. */
  sendEvent(message: QueuedMessage, preferences: AgentTurnPreferences): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The target session is closed.'));
    if (this.automaticWakeHeld) return Promise.reject(new Error('Automatic wake is held by the owner.'));
    return this.enqueueMessage(message, preferences, true);
  }

  /**
   * Why a queued message cannot join the running task right now; null when it
   * can. The live run's effort governs every steered message, so an effort
   * difference is never a reason to refuse — only a different destination,
   * workspace or project is.
   */
  private steeringRefusal(turn: QueuedTurn, current: QueuedMessage): string | null {
    const source = turn.message.communication?.source;
    const localOwner = !turn.automatic && (source === undefined || source === 'terminal' || source === 'web');
    const notification = source === 'inbox' || source === 'owner-inbox' || source === 'team' || source === 'worker';
    const currentRoute = current.communication?.replyTo;
    const nextRoute = turn.message.communication?.replyTo;
    const sameRoute = sameReplyRoute(currentRoute, nextRoute) || (!currentRoute && !nextRoute && localOwner);
    if (!(this.options.sessionWorkspaceRoot === null || localOwner || source === 'inbox' || source === 'worker'))
      return "This message's source cannot steer this task. It stays queued and runs next.";
    if (!(notification || sameRoute))
      return 'This message replies to a different destination than the running task. It stays queued and runs next.';
    if ((turn.message.workspaceRoot ?? this.runtime.workspaceRoot) !== (current.workspaceRoot ?? this.runtime.workspaceRoot))
      return 'This message targets a different workspace than the running task. It stays queued and runs next.';
    if (turn.message.projectContext?.id !== current.projectContext?.id)
      return 'This message targets a different project than the running task. It stays queued and runs next.';
    return null;
  }

  /** Steer only across a compatible response route, workspace and project. */
  private canAdmitSteering(turn: QueuedTurn, current: QueuedMessage): boolean {
    return turn.steering && this.steeringRefusal(turn, current) === null;
  }

  manageQueuedMessage(id: string, action: 'steer' | 'remove', sessionId: string): void {
    if (this.session.id !== sessionId) throw new Error('The active session has changed.');
    if (action === 'steer' && !this.busy) throw new Error('There is no running task to steer.');
    const index = this.queuedMessages.findIndex((turn) => turn.id === id && !turn.entryAdded && !turn.automatic);
    if (index < 0) throw new Error('This message is no longer queued.');
    if (action === 'steer' && this.queuedMessages[index]!.steering) return;
    if (action === 'steer' && this.activeSteeringMessage) {
      const refusal = this.steeringRefusal({ ...this.queuedMessages[index]!, steering: true }, this.activeSteeringMessage);
      if (refusal) throw new Error(refusal);
    }
    const [turn] = this.queuedMessages.splice(index, 1);
    if (action === 'remove') turn.resolve();
    else {
      turn.steering = true;
      // Preserve the order of explicit steering while moving it ahead of later work.
      const waiting = this.queuedMessages.findIndex((queued) => !queued.steering);
      this.queuedMessages.splice(waiting < 0 ? this.queuedMessages.length : waiting, 0, turn);
      this.queueHold = false;
    }
    this.publish(false);
  }

  private enqueueMessage(message: QueuedMessage, preferences: AgentTurnPreferences, automatic: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    const wasHeld = this.automaticWakeHeld || this.queueHold;
    if (!automatic && this.automaticWakeHeld) {
      this.session = { ...this.session, automaticWakeHeld: false };
      if (this.options.onAutomaticWakeReady) queueMicrotask(this.options.onAutomaticWakeReady);
    }
    // `/provider ...` is host configuration, not chat: consumed here so every
    // channel behaves the same and the model never interprets it. A message
    // carrying images is left alone; attachments must not vanish silently.
    if (message.images.length === 0 && isProviderCommand(message.text)) {
      return runProviderCommand(message.text).then((outcome) => this.addNotice(outcome.notice, outcome.tone));
    }
    if (message.images.length > 0) {
      message = {
        ...message,
        attachments: [
          ...(message.attachments ?? []),
          ...message.images.map((image, index) =>
            storeAttachment(
              this.session.id,
              decodeBase64Image(image.base64, image.mediaType, MAX_IMAGE_BYTES),
              `image-${index + 1}.png`,
              image.mediaType,
            ),
          ),
        ],
        images: [],
      };
    }
    if (!automatic && this.session.project) {
      const binding = this.session.project;
      const workspaceRoot = projectFolder(binding.workspaceRoot);
      const folders = binding.folders.map(projectFolder);
      message = {
        ...message,
        workspaceRoot,
        ...(binding.id && binding.name ? { projectContext: { id: binding.id, name: binding.name, folders } } : {}),
      };
      if (!binding.locked) {
        // Locked in memory until the first entry lands; an entry-less chat is
        // not a store file, so the message's own save persists the lock.
        this.session = saveSession({ ...this.session, project: { ...binding, locked: true } });
        this.publish(false);
      }
    }
    return new Promise<void>((resolve, reject) => {
      const source = message.communication?.source;
      // Owner decision (2026-10-31): every CLI follow-up steers into the live run.
      // Web keeps the explicit steer button; Telegram/inbox/team already steer.
      const steering =
        automatic || source === 'terminal' || source === 'inbox' || source === 'owner-inbox' || source === 'team' || source === 'worker';
      const turn: QueuedTurn = { id: randomUUID(), message, preferences, resolve, reject, automatic, steering };
      if (!automatic && wasHeld) {
        const events = this.queuedMessages.filter((queued) => queued.automatic);
        const ownerMessages = this.queuedMessages.filter((queued) => !queued.automatic);
        this.queuedMessages.splice(0, this.queuedMessages.length, ...ownerMessages, turn, ...events);
      } else this.queuedMessages.push(turn);
      if (this.busy) {
        // A send that lands in the stop's race window (the aborted run is still
        // settling) gets the same Esc-hold delivery as everything else: it goes
        // into the chat at once, but the hold survives — an abort we just asked
        // for must never restart a run on its own. The next explicit send
        // (idle path below) releases the hold and runs them together.
        if (!automatic && this.queueHold) this.materializeHeldTurn(turn);
        this.publish();
      } else {
        // An explicit send releases an Esc hold: held messages run together with this one.
        if (!automatic) this.queueHold = false;
        if (this.queueHold || (automatic && this.automaticWakeHeld)) return;
        void this.runQueuedMessages();
      }
    });
  }

  /** Resolve host notifications only when they are about to enter the conversation. */
  private async prepareQueuedTurn(turn: QueuedTurn, signal: AbortSignal): Promise<boolean> {
    if (!turn.message.beforeDelivery) return true;
    try {
      const text = await turn.message.beforeDelivery();
      if (signal.aborted || this.closed) throw new Error('Run cancelled before execution.');
      if (text === null) {
        if (turn.message.eventId) this.eventRunResults.set(turn.message.eventId, { error: null, outputs: [], skipped: true });
        turn.resolve();
        return false;
      }
      turn.message = { ...turn.message, text };
      return true;
    } catch (error) {
      // A notification refresh failure must not abort the owner's unrelated work.
      turn.reject(error);
      return false;
    }
  }

  private recoverFromUnsupportedImageInput(error: unknown): boolean {
    if (!isUnsupportedImageInputError(error)) return false;
    try {
      this.runtime.disableImageInput?.();
    } catch {
      // The provider-safe message projection below still prevents another image send.
    }
    this.runtime.supportsVision = false;
    const original = this.conversation;
    const stripped = omitUnsupportedImageInputs(original);
    if (stripped.changed) {
      if (this.conversationArchive.length === 0) this.conversationArchive = [...original];
      this.conversation = stripped.messages;
      this.publish();
    }
    return true;
  }

  private async runQueuedMessages(): Promise<void> {
    if (this.closed || this.busy) return;
    const initialTurn = this.queuedMessages.shift();
    if (!initialTurn) return;
    const abortController = new AbortController();
    this.runError = null;
    this.activeRunAbort = abortController;
    this.busy = true;
    reportSessionActivity(this.session.id, true);
    this.publish();
    let activeTurn: QueuedTurn | null = initialTurn;
    let runTurnId: string | undefined;
    let steeredTurns: QueuedTurn[] = [];
    /** Distinct report lines already shown to the running turn: one per state change. */
    const injectedReportLines = new Set<string>();
    const settleSteeredTurns = (ownerEventId: string | undefined) => {
      for (const turn of steeredTurns.splice(0)) {
        if (turn.message.eventId)
          this.eventRunResults.set(turn.message.eventId, {
            error: this.runError,
            outputs: [],
            ...(ownerEventId ? { replyHandledByEventId: ownerEventId } : {}),
          });
        turn.resolve();
      }
    };

    try {
      const [{ runAgent, buildAgentSystem }, { compactConversation }] = await Promise.all([
        import('./agent.js'),
        import('./compaction.js'),
      ]);
      let nextTurn: QueuedTurn | null = initialTurn;
      while (nextTurn) {
        const currentTurn = nextTurn;
        activeTurn = currentTurn;
        this.activeSteeringMessage = null;
        if (!(await this.prepareQueuedTurn(currentTurn, abortController.signal))) {
          activeTurn = null;
          if (abortController.signal.aborted) break;
          nextTurn = this.queuedMessages.shift() ?? null;
          continue;
        }
        // The model this chat picked is bound at the turn boundary, never in
        // the middle of a running request: a pick made while a run was going
        // becomes real here, and the chat's effort is re-mapped onto it.
        await this.restoreSessionModel();
        // The admitted turn's own message preferences govern it, but a session
        // that recorded its own effort always wins: the session is the single
        // authority, so a wake-up or another channel carrying the machine
        // default can never override what this chat was set to.
        this.activeTurnPreferences = {
          reasoningVariantId: this.session.reasoning ?? currentTurn.preferences.reasoningVariantId,
          showReasoning: this.session.showReasoning ?? currentTurn.preferences.showReasoning,
        };
        const current = currentTurn.message;
        this.resetAutoReviewTurn();
        this.runError = null;
        this.activeEventOutputs = [];
        this.activeEventAssistantText = '';
        steeredTurns = [];
        injectedReportLines.clear();
        this.activeTurnProgress = current.onProgress;
        // Private and persistent sessions can share a runtime. Rebind the
        // selected model at the turn boundary, never silently use another
        // session's most recently activated model.
        this.showReasoningAtTurnStart = this.sessionShowReasoning();
        if (current.workspaceRoot) {
          if (this.runtime.selectWorkspaceRoot) await this.runtime.selectWorkspaceRoot(current.workspaceRoot);
          else if (current.workspaceRoot !== this.runtime.workspaceRoot)
            throw new Error('This session runtime cannot change workspace scope.');
        }
        this.activeSteeringMessage = current;
        this.currentReviewAuthorization = current.reviewAuthorization ?? null;
        this.activeEventId = current.eventId;
        this.reportTurnProgress({ kind: 'start' });
        // Provider retries and key rotations belong to this turn's transcript.
        this.retryNotice = null;
        this.runtime.reportRetry?.((event) => this.reportModelRetry(event));
        let titleRequest: { sessionId: string; message: string } | null = null;
        if (!this.sessionHasUserMessage) {
          this.sessionHasUserMessage = true;
          const imageOnly = messageImageCount(current) > 0 && current.text === 'User attached image';
          const titleSeed = imageOnly ? 'Image chat' : current.text || (messageImageCount(current) > 0 ? 'Image chat' : 'New session');
          this.session = { ...this.session, title: fallbackSessionTitle(titleSeed) };
          if (current.text && !imageOnly) titleRequest = { sessionId: this.session.id, message: current.text };
          this.publish();
        }
        const userMessage = queuedUserMessageToModelMessage(current);
        this.streamedAssistantEntry = null;
        this.streamedReasoningEntry = null;
        if (!currentTurn.entryAdded) this.addUserEntry(current);
        else this.activeTurnId = currentTurn.turnId;
        runTurnId = this.activeTurnId;
        this.conversation.push(userMessage);
        if (this.conversationArchive.length > 0) this.conversationArchive.push(userMessage);
        const conversationAtRunStart = [...this.conversation];

        let refreshTools = false;
        let finalResponseReceived = false;
        let archivedResponseCount = 0;
        do {
          refreshTools = false;
          // Wait for an idle-time tool reconnect before capturing this turn's catalogue.
          await this.runtime.prepareForTurn?.();
          await this.runtime.reloadSettings?.();
          const schemaSanitizer = this.toolSchemaSanitizer();
          const tools = await (this.options.registry ?? this.runtime.registry).createModelTools({
            approve: (request, signal) => this.requestApproval(request, signal),
            approvalMode: () => this.runtime.approvalMode ?? 'workspace',
            autoApprove: (request) => this.options.autoApprove?.(request) ?? isToolRequestWhitelisted(this.runtime.workspaceRoot, request),
            allowToolAutoApproval: this.options.background !== true,
            sessionId: this.session.id,
            ...(schemaSanitizer ? { schemaSanitizer } : {}),
            ...(this.options.writeGuard ? { guardWrite: (path: string) => this.options.writeGuard!(this.session.id, path) } : {}),
            ...(this.options.background === true ? {} : { ask: (question, signal) => this.requestQuestion(question, signal) }),
            onStart: (request, toolCallId) => this.onToolStart(request, toolCallId),
            onResult: (request, result, toolCallId) => this.onToolResult(request, result, toolCallId),
            preview: {
              onStart: (info) => this.onToolPreviewStart(info),
              onDelta: (info) => this.onToolPreviewDelta(info),
              onAvailable: (info) => this.onToolPreviewAvailable(info),
            },
            onAction: (request, state, detail) =>
              this.recordAction?.({
                requestId: request.requestId,
                workspaceRoot: this.runtime.workspaceRoot,
                sessionId: this.session.id,
                ...(this.activeEventId ? { eventId: this.activeEventId } : {}),
                providerId: request.providerId,
                name: request.name,
                input: request.input,
                effect: request.effect,
                state,
                ...(detail?.result === undefined ? {} : { result: detail.result }),
                ...(detail?.error === undefined ? {} : { error: detail.error }),
              }),
            signal: abortController.signal,
          });
          let streamedTextReceived = false;
          try {
            const result = await runAgent({
              sessionId: this.session.id,
              model: this.sessionModel(),
              getModel: async () => {
                await this.runtime.reloadSettings?.();
                return this.sessionModel();
              },
              workspaceRoot: this.runtime.workspaceRoot,
              supportsVision: this.runtime.supportsVision,
              supportsImageToolResult: this.runtime.supportsImageToolResult,
              abortSignal: abortController.signal,
              messages: this.conversation,
              system: this.frozenSystemPrompt(buildAgentSystem),
              compactBeforeStep: async (context) => {
                this.currentReviewMessages = context.messages;
                // A compaction requested while this run was in flight is served
                // here: the previous tool batch has settled and the next model
                // request has not been sent yet, which is the safe boundary the
                // request was waiting for.
                const pendingCompaction = this.takePendingCompactionForStep();
                try {
                  const outcome = await compactConversation({
                    ...context,
                    onStepUsage: (report) => this.onStepUsage(report, 'compaction'),
                    archivePath: sessionFilePath(this.session.id),
                    model: this.sessionModel(),
                    contextWindowTokens: this.effectiveContextWindowTokensForCompaction(),
                    outputLimitTokens: this.runtime.outputLimitTokens,
                    ...(this.lastContextUsage !== undefined ? { previousContextTokens: this.lastContextUsage } : {}),
                    ...(this.lastContextEstimate !== undefined ? { previousContextEstimateTokens: this.lastContextEstimate } : {}),
                    ...(pendingCompaction
                      ? {
                          force: true,
                          ...(pendingCompaction.recovery ? { recovery: true } : {}),
                          providerOptions: this.runtime.getReasoningProviderOptions(
                            pendingCompaction.preferences.reasoningVariantId,
                            pendingCompaction.preferences.showReasoning,
                          ),
                        }
                      : {}),
                    onStart: () => {
                      this.flushStreamedEntries();
                      // The row names its turn, so grouping never depends on where
                      // the message that arrived during the compaction put it.
                      const turnId = this.compactionTurn();
                      const entry: Extract<SessionEntry, { kind: 'compaction' }> = {
                        kind: 'compaction',
                        status: 'running',
                        ...(turnId === undefined ? {} : { turnId }),
                        ...(this.lastContextUsage === undefined ? {} : { beforeTokens: this.lastContextUsage }),
                      };
                      this.compactionEntry = entry;
                      this.addEntry(entry);
                    },
                    onTextDelta: (delta) => this.queueStreamDelta('assistant', delta, 'compaction'),
                    onReasoningDelta: (delta) => this.queueStreamDelta('reasoning', delta, 'compaction'),
                    onReasoningEnd: () => this.endStreamedReasoning(),
                    abortSignal: abortController.signal,
                  });
                  if (outcome.kind === 'compacted') {
                    this.currentReviewMessages = outcome.result.messages;
                    return outcome.result;
                  }
                  // A refusal is budget arithmetic, not a failure: the transcript
                  // explains it and the turn runs with the original context, where
                  // the provider still validates the real request size.
                  if (outcome.kind === 'impossible') {
                    this.failRunningCompaction();
                    this.addNotice(this.compactionRefusalNotice(outcome), 'warn', this.compactionRefusalCause(outcome));
                  }
                  return null;
                } catch (error) {
                  // A summarization failure must never cost the owner their message:
                  // report it, keep the original context, let the turn continue.
                  this.failRunningCompaction();
                  if (abortController.signal.aborted) throw error;
                  const unsupportedImageInput = this.recoverFromUnsupportedImageInput(error);
                  this.addNotice(
                    unsupportedImageInput
                      ? 'The provider rejected image input. Image input is disabled for this model, and the conversation can continue.'
                      : `Compaction failed: ${error instanceof Error ? error.message : String(error)} The turn continues with the original context.`,
                    'warn',
                  );
                  return null;
                }
              },
              onCompactionComplete: (result, generatedMessages) => {
                if (this.conversationArchive.length === 0) this.conversationArchive = [...conversationAtRunStart];
                appendUniqueQueuedMessages(this.conversationArchive, generatedMessages.slice(archivedResponseCount));
                archivedResponseCount = generatedMessages.length;
                this.applyCompaction(result);
              },
              tools: tools.tools,
              shouldStop: tools.shouldStop,
              takeQueuedMessages: async () => {
                // Steering is admitted only at SDK prepareStep, after the prior tool batch.
                // Scope/route changes remain FIFO followups so they cannot borrow an active binding.
                // Owner-inbox and team signals carry no owner reply binding, so they steer any live run.
                // CLI (terminal) owner messages steer by default — owner decision 2026-10-31;
                // web owner messages wait for the next turn unless the steer button promotes them.
                const admitted: ReturnType<typeof queuedUserMessageToModelMessage>[] = [];
                for (;;) {
                  // Skip incompatible steering rather than letting one queued
                  // message block later eligible owner corrections or notifications.
                  const index = this.queuedMessages.findIndex((turn) => this.canAdmitSteering(turn, current));
                  if (index < 0) break;
                  const next = this.queuedMessages[index]!;
                  this.queuedMessages.splice(index, 1);
                  if (!(await this.prepareQueuedTurn(next, abortController.signal))) {
                    if (abortController.signal.aborted) break;
                    continue;
                  }
                  this.flushStreamedEntries();
                  this.flushEventAssistantText();
                  if (!next.entryAdded) this.addUserEntry(next.message, true);
                  else if (next.turnId && this.activeTurnId && next.turnId !== this.activeTurnId) {
                    // A held message was shown before admission. Once steered, it belongs to this run.
                    const entry = this.session.entries.find((entry) => entry.kind === 'user' && entry.turnId === next.turnId);
                    if (entry) this.replaceEntry(entry, { ...entry, turnId: this.activeTurnId });
                    next.turnId = this.activeTurnId;
                  }
                  steeredTurns.push(next);
                  admitted.push(queuedUserMessageToModelMessage(next.message, true));
                }
                // A report from below is a projection, not a message from the owner:
                // the line reaches the model's step, never the transcript, and the
                // inbox record stays unread so the head can still open it in full.
                const reportLine = this.options.pendingReports?.() ?? null;
                if (reportLine && !injectedReportLines.has(reportLine)) {
                  injectedReportLines.add(reportLine);
                  admitted.push({ role: 'user', content: [{ type: 'text', text: reportLine }] });
                }
                return admitted;
              },
              getProviderOptions: () => {
                const live = this.liveTurnPreferences();
                return this.runtime.getReasoningProviderOptions(live.reasoningVariantId, live.showReasoning);
              },
              onTextDelta: (delta) => {
                streamedTextReceived = true;
                this.activeEventAssistantText += delta;
                this.reportTurnProgress({ kind: 'assistant-delta', text: delta });
                this.queueStreamDelta('assistant', delta);
              },
              onReasoningDelta: (delta) => this.queueStreamDelta('reasoning', delta),
              onReasoningEnd: () => this.endStreamedReasoning(),
              onConversationProgress: (conversation, responseMessages) => {
                this.conversation = conversation;
                if (this.conversationArchive.length > 0) {
                  this.conversationArchive.push(...responseMessages.slice(archivedResponseCount));
                  archivedResponseCount = responseMessages.length;
                }
              },
              onContextUsage: (inputTokens, contextEstimateTokens) => this.onContextUsage(inputTokens, contextEstimateTokens),
              onStepUsage: (report) => this.onStepUsage(report),
            });
            this.flushStreamedEntries();
            finalResponseReceived = Boolean(result.finalText.trim());
            if (abortController.signal.aborted) {
              break;
            }
            if (result.conversation) this.conversation = result.conversation;
            else appendUniqueQueuedMessages(this.conversation, result.response.messages);
            if (this.conversationArchive.length > 0) {
              appendUniqueQueuedMessages(this.conversationArchive, result.response.messages.slice(archivedResponseCount));
            }
            this.publish();
            if (!streamedTextReceived && result.text.trim()) {
              const text = result.text.trim();
              this.addEntry({ kind: 'assistant', text });
              this.activeEventOutputs?.push({ kind: 'assistant', text });
              this.reportTurnProgress({ kind: 'assistant-delta', text });
            }
            if (tools.shouldRestart()) refreshTools = true;
            else if (tools.shouldStop()) this.addNotice('The tool call was denied; this run has stopped.', 'warn');
            else if (this.queuedMessages.some((turn) => this.canAdmitSteering(turn, current))) {
              // A provider may finish the current request without another SDK
              // prepareStep (for example after a parallel batch or final text).
              // Start a new model request in this same turn so the explicitly
              // promoted message enters before the run is marked complete.
              refreshTools = true;
              finalResponseReceived = false;
            }
          } catch (error) {
            this.flushStreamedEntries();
            this.flushEventAssistantText();
            const unsupportedImageInput = this.recoverFromUnsupportedImageInput(error);
            this.runError = abortController.signal.aborted
              ? 'Run cancelled.'
              : unsupportedImageInput
                ? 'The provider rejected image input. Image input is disabled for this model, and the conversation can continue.'
                : error instanceof Error
                  ? error.message
                  : String(error);
            if (!abortController.signal.aborted) this.addNotice(this.runError, 'error');
          }
        } while (refreshTools && !abortController.signal.aborted);
        this.settleToolPreviews();

        if (current.communication?.replyTo && !finalResponseReceived && !this.runError && !abortController.signal.aborted) {
          // One tool-free finalization, based on settled results; completed actions never repeat.
          try {
            const answerBase = this.options.basePolicy ?? AGENT_BASE;
            const answer = await runAgent({
              sessionId: this.session.id,
              model: this.sessionModel(),
              workspaceRoot: this.runtime.workspaceRoot,
              supportsVision: this.runtime.supportsVision,
              supportsImageToolResult: this.runtime.supportsImageToolResult,
              messages: this.conversation,
              tools: {},
              maxRetries: 0,
              abortSignal: abortController.signal,
              basePolicy: {
                ...answerBase,
                instructions: `${answerBase.instructions}\nThe owner's request requires a visible answer. Compose it from the settled work and tool results. Do not call tools or repeat actions.`,
              },
              getProviderOptions: () => {
                const live = this.liveTurnPreferences();
                return this.runtime.getReasoningProviderOptions(live.reasoningVariantId, live.showReasoning);
              },
              onTextDelta: (delta) => {
                this.activeEventAssistantText += delta;
                this.reportTurnProgress({ kind: 'assistant-delta', text: delta });
                this.queueStreamDelta('assistant', delta);
              },
            });
            this.flushStreamedEntries();
            this.conversation = answer.conversation;
            if (this.conversationArchive.length > 0) appendUniqueQueuedMessages(this.conversationArchive, answer.response.messages);
            if (!answer.finalText.trim()) throw new Error('The run finished without a user-facing answer.');
          } catch (error) {
            this.flushStreamedEntries();
            const unsupportedImageInput = this.recoverFromUnsupportedImageInput(error);
            this.runError = abortController.signal.aborted
              ? 'Run cancelled.'
              : unsupportedImageInput
                ? 'The provider rejected image input. Image input is disabled for this model, and the conversation can continue.'
                : error instanceof Error
                  ? error.message
                  : String(error);
            if (!abortController.signal.aborted) this.addNotice(this.runError, 'error');
          }
        }

        if (titleRequest && !abortController.signal.aborted) this.generateTitleInBackground(titleRequest);
        if (abortController.signal.aborted) this.runError = 'Run cancelled.';
        if (current.eventId) {
          this.flushEventAssistantText();
          this.eventRunResults.set(current.eventId, {
            error: this.runError,
            outputs: [...(this.activeEventOutputs ?? [])],
          });
        }
        this.activeEventOutputs = null;
        this.activeEventAssistantText = '';
        this.activeTurnProgress = undefined;
        this.finishTurn(runTurnId, abortController.signal.aborted);
        runTurnId = undefined;
        currentTurn.resolve();
        settleSteeredTurns(current.eventId);
        this.touchActivity();
        this.activeSteeringMessage = null;
        activeTurn = null;
        if (abortController.signal.aborted) break;
        nextTurn = this.queuedMessages.shift() ?? null;
        this.publish();
      }
    } catch (error) {
      this.flushStreamedEntries();
      this.flushEventAssistantText();
      const unsupportedImageInput = this.recoverFromUnsupportedImageInput(error);
      this.runError = abortController.signal.aborted
        ? 'Run cancelled.'
        : unsupportedImageInput
          ? 'The provider rejected image input. Image input is disabled for this model, and the conversation can continue.'
          : error instanceof Error
            ? error.message
            : String(error);
      if (!abortController.signal.aborted) this.addNotice(this.runError, 'error');
      if (activeTurn) {
        if (activeTurn.message.eventId) {
          this.eventRunResults.set(activeTurn.message.eventId, {
            error: this.runError,
            outputs: [...(this.activeEventOutputs ?? [])],
          });
        }
        activeTurn.resolve();
        settleSteeredTurns(activeTurn.message.eventId);
        activeTurn = null;
      }
    } finally {
      this.finishTurn(runTurnId, abortController.signal.aborted);
      if (this.approvalResolver) this.approveToolCall('deny');
      if (this.questionResolver) this.answerQuestion(null);
      this.settleToolPreviews();
      this.pendingApproval = null;
      this.pendingApprovalId = null;
      this.pendingQuestion = null;
      this.questionResolver = null;
      if (abortController.signal.aborted) this.runError = 'Run cancelled.';
      this.activeEventOutputs = null;
      this.activeEventAssistantText = '';
      this.activeTurnProgress = undefined;
      this.activeEventId = undefined;
      this.busy = false;
      this.activeTurnId = undefined;
      this.activeSteeringMessage = null;
      this.activeTurnPreferences = null;
      // No run is active any more, so a late retry event must not write here.
      this.runtime.reportRetry?.(null);
      this.retryNotice = null;
      reportSessionActivity(this.session.id, false);
      if (this.activeRunAbort === abortController) this.activeRunAbort = null;
      this.publish();
      // A compaction that no step could serve runs now, before any newly
      // queued turn. The deferred re-check covers a request that read
      // `busy === true` just before this boundary cleared the flag: without it
      // the queued request would sit until the end of the next run.
      this.servePendingCompactionOrQueue();
      queueMicrotask(() => this.servePendingCompactionOrQueue());
    }
  }

  private cancelTitleGeneration(): void {
    this.titleAbort?.abort();
    this.titleAbort = null;
  }

  private generateTitleInBackground(request: { sessionId: string; message: string }): void {
    this.cancelTitleGeneration();
    const controller = new AbortController();
    this.titleAbort = controller;
    const fallback = this.session.title;
    void (async () => {
      try {
        const live = this.liveTurnPreferences();
        // With a title role assigned the clerk runs there - on the cheapest
        // expressible options - and a session without one stays on its chat model
        // with the chat's own reasoning settings, as it always did.
        const providerOptions = this.runtime.titleModel
          ? (this.runtime.getTitleProviderOptions?.() ?? {})
          : this.runtime.getReasoningProviderOptions(live.reasoningVariantId, live.showReasoning);
        // Metadata must not rotate the active conversation's keys or report retries into its next turn.
        const model = bindSessionKeyRotation(this.runtime.titleModel ?? this.runtime.model, { ...this.session.keyPositions }, () => {});
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
        const title = await generateSessionTitle(model, request.message, signal, providerOptions);
        if (!this.closed && !signal.aborted && this.session.id === request.sessionId && this.session.title === fallback) {
          this.session = { ...this.session, title };
          this.publish();
        }
      } catch {
        // The first-message fallback remains valid when metadata generation fails.
      } finally {
        if (this.titleAbort === controller) this.titleAbort = null;
      }
    })();
  }

  /** Run the queued compaction, otherwise start the next queued turn. */
  private servePendingCompactionOrQueue(): void {
    if (this.closed || this.busy) return;
    const pendingCompaction = this.pendingCompaction;
    if (pendingCompaction) {
      this.pendingCompaction = null;
      void this.compact(pendingCompaction.preferences, pendingCompaction.recovery, pendingCompaction.scopeRoot);
    } else if (!this.queueHold && this.queuedMessages.length > 0) {
      void this.runQueuedMessages();
    }
  }

  /**
   * Take the queued compaction request when it can run inside the live run.
   *
   * A request carrying another workspace scope cannot be served here: changing
   * the scope mid-run would move the active turn, so it stays queued for the
   * run's end, where the scope is selected before compacting.
   */
  private takePendingCompactionForStep(): { preferences: AgentTurnPreferences; recovery: boolean } | null {
    const pending = this.pendingCompaction;
    if (!pending) return null;
    if (pending.scopeRoot !== undefined && pending.scopeRoot !== this.runtime.workspaceRoot) return null;
    this.pendingCompaction = null;
    return { preferences: pending.preferences, recovery: pending.recovery };
  }

  async compact(preferences: AgentTurnPreferences, recovery = false, scopeRoot?: string): Promise<void> {
    if (this.closed) return;
    // Compaction rewrites the conversation, so it must not run while a turn is
    // in flight. Instead of refusing, queue it: the run serves it at the next
    // step boundary (after the pending tool batch, before the next model
    // request) and falls back to the run's end when no step follows.
    if (this.busy) {
      this.pendingCompaction = { preferences, recovery, ...(scopeRoot === undefined ? {} : { scopeRoot }) };
      this.addNotice('Compaction is queued; it runs at the next step boundary or when the run finishes.');
      return;
    }
    if (scopeRoot !== undefined && this.runtime.selectWorkspaceRoot) await this.runtime.selectWorkspaceRoot(scopeRoot);
    if (this.conversation.length === 0) {
      this.addNotice('There is no conversation to compact.');
      return;
    }
    const abortController = new AbortController();
    this.activeRunAbort = abortController;
    // The row lands in the turn the transcript already ends in, so that turn
    // stays the run's turn while the compaction is being written.
    this.compactionTurnId = this.lastTranscriptTurnId();
    this.busy = true;
    reportSessionActivity(this.session.id, true);
    this.publish();
    try {
      const [{ getAgentContext, buildAgentSystem }, { compactConversation }] = await Promise.all([
        import('./agent.js'),
        import('./compaction.js'),
      ]);
      const context = getAgentContext(
        this.conversation,
        this.runtime.supportsImageToolResult,
        this.runtime.workspaceRoot,
        this.options.basePolicy,
        this.runtime.supportsVision,
        // The session's frozen prompt: the compaction request shares its prefix
        // with the turn that triggered it, so only the appended prompt is new.
        this.frozenSystemPrompt(buildAgentSystem),
        this.session.id,
      );
      const schemaSanitizer = this.toolSchemaSanitizer();
      const tools = await this.runtime.registry.createModelTools({
        approve: async () => false,
        onResult: () => {},
        ...(schemaSanitizer ? { schemaSanitizer } : {}),
      });
      const outcome = await compactConversation({
        ...context,
        archivePath: sessionFilePath(this.session.id),
        tools: tools.tools,
        model: this.sessionModel(),
        contextWindowTokens: this.effectiveContextWindowTokensForCompaction(),
        outputLimitTokens: this.runtime.outputLimitTokens,
        ...(this.lastContextUsage !== undefined ? { previousContextTokens: this.lastContextUsage } : {}),
        ...(this.lastContextEstimate !== undefined ? { previousContextEstimateTokens: this.lastContextEstimate } : {}),
        providerOptions: this.runtime.getReasoningProviderOptions(preferences.reasoningVariantId, preferences.showReasoning),
        onStepUsage: (report) => this.onStepUsage(report, 'compaction'),
        onStart: () => {
          this.flushStreamedEntries();
          // The row exists from the first moment so the reader sees "compacting"
          // instead of a silent pause; applyCompaction replaces it in place.
          // It names its turn: a standalone compaction runs with no active run,
          // so position alone would decide which turn its rows fall into.
          const turnId = this.compactionTurn();
          const entry: Extract<SessionEntry, { kind: 'compaction' }> = {
            kind: 'compaction',
            status: 'running',
            ...(turnId === undefined ? {} : { turnId }),
            ...(this.lastContextUsage === undefined ? {} : { beforeTokens: this.lastContextUsage }),
          };
          this.compactionEntry = entry;
          this.addEntry(entry);
          if (recovery)
            this.addNotice(
              'Recovering compaction: earlier reasoning is omitted from this one request; dialogue and tool data are preserved. The full transcript remains archived.',
            );
        },
        onTextDelta: (delta) => this.queueStreamDelta('assistant', delta, 'compaction'),
        onReasoningDelta: (delta) => this.queueStreamDelta('reasoning', delta, 'compaction'),
        onReasoningEnd: () => this.endStreamedReasoning(),
        abortSignal: abortController.signal,
        force: true,
        ...(recovery ? { recovery: true } : {}),
      });
      if (outcome.kind === 'compacted') this.applyCompaction(outcome.result);
      else if (outcome.kind === 'impossible') {
        this.failRunningCompaction();
        this.addNotice(this.compactionRefusalNotice(outcome), 'warn', this.compactionRefusalCause(outcome));
      }
    } catch (error) {
      this.failRunningCompaction();
      const unsupportedImageInput = this.recoverFromUnsupportedImageInput(error);
      if (!abortController.signal.aborted)
        this.addNotice(
          unsupportedImageInput
            ? 'The provider rejected image input. Image input is disabled for this model, and the conversation can continue.'
            : `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
          unsupportedImageInput ? 'warn' : 'error',
        );
    } finally {
      this.busy = false;
      this.activeTurnId = undefined;
      this.compactionTurnId = null;
      this.runtime.reportRetry?.(null);
      this.retryNotice = null;
      reportSessionActivity(this.session.id, false);
      if (this.activeRunAbort === abortController) this.activeRunAbort = null;
      this.publish();
      if (!this.closed && !this.queueHold && this.queuedMessages.length > 0) void this.runQueuedMessages();
    }
  }

  private applyCompaction(result: CompactionResult): void {
    this.flushStreamedEntries();
    if (this.conversationArchive.length === 0) this.conversationArchive = [...this.conversation];
    this.conversation = result.messages;
    // The rewrite has already killed the message prefix, so this is the cheapest
    // point to re-read the reference block; refreshSystemPrompt explains why the
    // refresh must not move any earlier.
    this.refreshSystemPrompt();
    this.lastContextUsage = undefined;
    this.lastContextEstimate = undefined;
    const session = { ...this.session };
    delete session.contextTokens;
    delete session.contextEstimateTokens;
    this.session = session;
    // The compaction row replaces the one that was running, so the transcript
    // shows one event that changed state instead of two unrelated notices.
    const turnId = this.compactionTurn();
    const finished: Extract<SessionEntry, { kind: 'compaction' }> = {
      kind: 'compaction',
      status: 'done',
      ...(turnId === undefined ? {} : { turnId }),
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
    };
    const started = this.compactionEntry;
    this.compactionEntry = null;
    if (started) this.replaceEntry(started, finished);
    else this.addEntry(finished);
  }

  /**
   * One accounting row per model request. Nothing here can fail a run: the sink is
   * best effort and the ledger write is fire and forget.
   */
  private onStepUsage(report: StepUsageReport, runKind: UsageRecordInput['runKind'] = 'chat'): void {
    const sink = this.runtime.recordUsage;
    if (!sink) return;
    sink(
      {
        sessionId: this.session.id,
        ...(this.activeEventId ? { eventId: this.activeEventId } : {}),
        runKind,
        ...(this.runtime.workspaceRoot ? { workspaceRoot: this.runtime.workspaceRoot } : {}),
        providerId: this.runtime.providerId,
        modelId: this.runtime.modelId,
        atMs: report.startedAt,
        endedMs: report.endedAt,
        attempt: report.attempt,
        status: report.status,
        tokens: report.usage,
        ...(report.raw === undefined ? {} : { usageRaw: report.raw }),
        ...(report.providerMetadata === undefined ? {} : { providerMetadata: report.providerMetadata }),
        ...(report.responseId === undefined ? {} : { responseId: report.responseId }),
      },
      `${this.session.id}:${report.startedAt}:${report.attempt}`,
    );
  }

  private onContextUsage(inputTokens: number | null, contextEstimateTokens: number): void {
    if (inputTokens !== null) {
      this.lastContextUsage = inputTokens;
      this.lastContextEstimate = contextEstimateTokens;
    }
    this.session = {
      ...this.session,
      ...(this.runtime.contextWindowTokens === null ? {} : { contextWindowTokens: this.runtime.contextWindowTokens }),
      ...(inputTokens === null ? {} : { contextTokens: inputTokens }),
      ...(inputTokens === null ? {} : { contextEstimateTokens }),
    };
    this.publish();
  }
}

function toolIdentity(request: Pick<ToolCallRequest, 'providerId' | 'name'>): string {
  return `${request.providerId}:${request.name}`;
}

/** Worker session id for subagent-family results; the machine-readable half of the display contract. */
function workerSessionId(request: Pick<ToolCallRequest, 'providerId' | 'name'>, value: unknown): string | undefined {
  if (
    request.providerId !== 'host' ||
    (request.name !== 'subagent' && request.name !== 'inbox' && request.name !== 'subagent_poll' && request.name !== 'subagent_stop')
  ) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (request.name === 'inbox') {
    const items = (value as Record<string, unknown>).items;
    if (!Array.isArray(items) || items.length !== 1) return undefined;
    const item = items[0];
    if (!item || typeof item !== 'object' || item.source !== 'Subagent') return undefined;
    const session = item.content?.session;
    return typeof session === 'string' ? session : undefined;
  }
  const session = (value as Record<string, unknown>).session;
  return typeof session === 'string' && session ? session : undefined;
}

export function toolDisplayCommand(request: Pick<ToolCallRequest, 'providerId' | 'name' | 'input'>): string {
  return displayToolCommand({ ...request, input: redactSensitive(request.input) as Record<string, unknown> });
}

/** Complete input, redacted once before it enters the transcript. */
export function toolDisplayInput(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(input, (key, value: unknown) => {
      const kind = classifySensitiveEntry(key, value);
      if (kind === 'secret') return '[redacted]';
      if (kind === 'media') return `[media payload omitted; ${(value as string).length} chars]`;
      return typeof value === 'string' ? redactSensitiveText(value) : value;
    }),
  ) as Record<string, unknown>;
}

function toolDisplayName(providerId: string, name: string): string {
  return providerId === 'host' ? name : `${providerId}/${name}`;
}

/** Best available one-line label from the fields a provider has streamed so far. */
export function toolPreviewCommand(
  providerId: string,
  name: string,
  fields: readonly { key: string; value: string }[],
  title?: string,
): string {
  const input: Record<string, unknown> = {};
  for (const field of fields) input[field.key] = field.value;
  if (title !== undefined) return title;
  if (providerId === 'host' && name === 'execute_command' && typeof input.command === 'string') return input.command;
  if (providerId === 'host' && (name === 'file_read' || name === 'file_write' || name === 'file_edit') && typeof input.path === 'string')
    return `${name === 'file_read' ? 'Read' : name === 'file_write' ? 'Write' : 'Edit'} ${input.path}`;
  if (providerId === 'host' && (name === 'glob' || name === 'grep') && typeof input.pattern === 'string') {
    const source = typeof input.path === 'string' ? ` in ${input.path}` : '';
    return `${name === 'glob' ? 'Glob' : 'Grep'} ${input.pattern}${source}`;
  }
  if (providerId === 'host' && name === 'mcp_manage' && typeof input.action === 'string') {
    return ['mcp_manage', input.action, input.serverId].filter((part) => typeof part === 'string').join(' ');
  }
  if (providerId === 'host') {
    const pick = (key: string, maxChars = 60): string | undefined => {
      const field = fields.find((candidate) => candidate.key === key);
      if (!field || !field.value) return undefined;
      return field.value.length > maxChars ? `${field.value.slice(0, maxChars)}…` : field.value;
    };
    switch (name) {
      case 'inbox':
        return `Inbox ${pick('action') ?? 'list'}${pick('source') ? ` · ${pick('source')}` : ''}`;
      case 'question': {
        const question = pick('question', 80);
        return question ? `Ask "${question}"` : 'question';
      }
      case 'subagent': {
        const mode = pick('mode', 8);
        const task = pick('task', 120);
        return `subagent${mode ? ` ${mode}` : ''}${task ? ` · ${task}` : ''}`;
      }
      case 'subagent_poll': {
        const session = pick('session', 8);
        return session ? `Poll ${session}` : 'subagent_poll';
      }
      case 'subagent_stop': {
        const session = pick('session', 8);
        return session ? `Stop ${session}` : 'subagent_stop';
      }
      case 'session_read': {
        const session = pick('session', 8);
        return session ? `Read session ${session}` : 'session_read';
      }
      case 'session_search': {
        const query = pick('query', 60);
        return query ? `Search sessions "${query}"` : 'session_search';
      }
      case 'session_list': {
        const scope = pick('scope', 9);
        return scope ? `Sessions ${scope}` : 'session_list';
      }
      case 'session_message': {
        const session = pick('session', 8);
        return session ? `Message ${session}` : 'session_message';
      }
      case 'parent_message': {
        const text = pick('text', 80);
        return text ? `Note "${text}"` : 'parent_message';
      }
      case 'memory_search': {
        const query = pick('query', 60);
        return query ? `Search memory "${query}"` : 'memory_search';
      }
      case 'schedule': {
        const action = pick('action', 12);
        return action ? `Schedule ${action}` : 'schedule';
      }
    }
  }
  const first = fields[0];
  return first ? `${toolDisplayName(providerId, name)} ${first.value}` : toolDisplayName(providerId, name);
}

export function formatToolResult(request: Pick<ToolCallRequest, 'providerId' | 'name'>, value: unknown): { outcome: string; text: string } {
  if (value === null || value === undefined) return { outcome: 'result', text: '' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { outcome: 'result', text: typeof value === 'string' ? value : String(value) };
  }
  const result = value as Record<string, unknown>;
  if (request.providerId === 'host') {
    const display = displayHostToolResult(request.name, result);
    if (display !== undefined) return display;
  }
  if (typeof result.error === 'string' && result.error) {
    return { outcome: typeof result.status === 'string' ? result.status : 'error', text: result.error };
  }
  if (typeof result.message === 'string' && result.message) {
    return { outcome: typeof result.status === 'string' ? result.status : 'result', text: result.message };
  }
  return formatExecOutput(result);
}

/** Content-first display text for host tool results; undefined defers to the generic rules. */
function displayHostToolResult(name: string, result: Record<string, unknown>): { outcome: string; text: string } | undefined {
  if (name === 'inbox' && Array.isArray(result.items)) {
    const lines = [`Inbox · ${result.items.length} notification(s)`];
    for (const raw of result.items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const content = item.content;
      const worker =
        content && typeof content === 'object' && !Array.isArray(content)
          ? displayHostToolResult('subagent_poll', content as Record<string, unknown>)
          : undefined;
      lines.push(
        `${String(item.source)}${worker ? `\n${worker.text}` : content === undefined ? ` · ${String(item.state)}` : `\n${JSON.stringify(content)}`}`,
      );
    }
    if (Array.isArray(result.errors)) for (const error of result.errors) lines.push(`! ${JSON.stringify(error)}`);
    return { outcome: String(result.status ?? 'completed'), text: lines.join('\n') };
  }
  switch (name) {
    case 'file_write': {
      if (result.status !== 'completed') return undefined;
      const stat = diffStatLine(result);
      return { outcome: 'completed', text: stat ? stat : 'Wrote' };
    }
    case 'file_edit': {
      if (result.status !== 'completed') return undefined;
      const stat = diffStatLine(result);
      return { outcome: 'completed', text: stat ? stat : 'Edited' };
    }
    case 'file_read': {
      if (result.status !== 'completed') return undefined;
      if (typeof result.content === 'string') {
        const path = typeof result.path === 'string' ? result.path : 'file';
        const offset = typeof result.offset === 'number' ? result.offset : 1;
        const endLine = typeof result.endLine === 'number' ? result.endLine : offset;
        const more = result.truncated === true || result.hasMore === true ? '+' : '';
        return { outcome: 'completed', text: `${path} · lines ${offset}–${endLine}${more}\n${result.content}` };
      }
      if (Array.isArray(result.entries)) {
        const path = typeof result.path === 'string' ? result.path : 'directory';
        const total = typeof result.totalEntries === 'number' ? result.totalEntries : result.entries.length;
        const names = result.entries
          .map((entry) => {
            if (typeof entry !== 'object' || entry === null) return null;
            const item = entry as Record<string, unknown>;
            if (typeof item.name !== 'string') return null;
            return `${item.name}${item.type === 'directory' ? '/' : ''}`;
          })
          .filter((name): name is string => name !== null);
        return { outcome: 'completed', text: `${path} · ${total} ${total === 1 ? 'entry' : 'entries'}\n${names.join('\n')}` };
      }
      return undefined;
    }
    case 'execute_command': {
      const base = formatExecOutput(result);
      if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
        return { outcome: base.outcome, text: `exit ${result.exitCode}${base.text ? `\n${base.text}` : ''}` };
      }
      if (result.truncated === true && base.text) return { outcome: base.outcome, text: `${base.text}\n… (output truncated)` };
      return base;
    }
    case 'glob': {
      if (result.status !== 'completed') return undefined;
      const files = Array.isArray(result.files) ? result.files.filter((file): file is string => typeof file === 'string') : [];
      const count = typeof result.count === 'number' ? result.count : files.length;
      return {
        outcome: 'completed',
        text: `${count} file${count === 1 ? '' : 's'}${result.truncated === true ? '+' : ''}\n${files.join('\n')}`,
      };
    }
    case 'grep': {
      if (result.status !== 'completed') return undefined;
      const matches = Array.isArray(result.matches) ? result.matches : [];
      const lines = matches
        .map((match) => {
          if (typeof match !== 'object' || match === null) return null;
          const item = match as Record<string, unknown>;
          if (typeof item.path !== 'string' || typeof item.line !== 'number' || typeof item.text !== 'string') return null;
          return `${item.path}:${item.line}: ${oneLine(item.text, 200) ?? ''}`;
        })
        .filter((line): line is string => line !== null);
      return {
        outcome: 'completed',
        text: `${matches.length} match${matches.length === 1 ? '' : 'es'}${result.truncated === true ? '+' : ''}\n${lines.join('\n')}`,
      };
    }
    case 'session_list': {
      if (result.status !== 'completed' || !Array.isArray(result.sessions)) return undefined;
      const scope = result.scope === 'workspace' ? 'workspace' : 'all';
      const lines = result.sessions
        .map((session) => {
          if (typeof session !== 'object' || session === null) return null;
          const item = session as Record<string, unknown>;
          if (typeof item.id !== 'string' || typeof item.title !== 'string') return null;
          const date = typeof item.updatedAt === 'string' ? ` · ${item.updatedAt.slice(0, 16).replace('T', ' ')}` : '';
          return `- ${item.title} (${item.id.slice(0, 8)}${date})`;
        })
        .filter((line): line is string => line !== null);
      return {
        outcome: 'completed',
        text: `${result.sessions.length} session${result.sessions.length === 1 ? '' : 's'} (${scope})\n${lines.join('\n')}`,
      };
    }
    case 'session_search': {
      if (result.status !== 'completed' || !Array.isArray(result.matches)) return undefined;
      const total = typeof result.total === 'number' ? result.total : result.matches.length;
      const query = typeof result.query === 'string' ? result.query : '';
      const lines = result.matches
        .map((match) => {
          if (typeof match !== 'object' || match === null) return null;
          const item = match as Record<string, unknown>;
          if (typeof item.sessionId !== 'string' || typeof item.title !== 'string') return null;
          const entry = typeof item.entry === 'number' ? ` #${item.entry}` : '';
          const snippet = typeof item.snippet === 'string' ? oneLine(item.snippet, 160) : undefined;
          return `- ${item.title}${entry}${snippet ? `: ${snippet}` : ''}`;
        })
        .filter((line): line is string => line !== null);
      return { outcome: 'completed', text: `${total} match${total === 1 ? '' : 'es'} for "${query}"\n${lines.join('\n')}` };
    }
    case 'session_read': {
      if (result.status !== 'completed' || !Array.isArray(result.entries)) return undefined;
      const session = typeof result.session === 'object' && result.session !== null ? (result.session as Record<string, unknown>) : null;
      const title = session !== null && typeof session.title === 'string' ? session.title : 'session';
      const id = session !== null && typeof session.id === 'string' && session.id ? ` (${session.id.slice(0, 8)})` : '';
      const entryCount = typeof result.entryCount === 'number' ? result.entryCount : result.entries.length;
      const offset = typeof result.offset === 'number' ? result.offset : 1;
      const endOffset = typeof result.endOffset === 'number' ? result.endOffset : offset;
      const lines = [`Session ${title}${id} · ${offset}–${endOffset} of ${entryCount}`];
      let used = lines[0]!.length;
      for (const entry of result.entries) {
        if (typeof entry !== 'object' || entry === null) continue;
        const item = entry as Record<string, unknown>;
        let line: string | undefined;
        if (item.kind === 'tool') {
          const command = oneLine(item.command, 100) ?? '?';
          const firstResult = typeof item.result === 'string' ? oneLine(item.result.split('\n')[0], 100) : undefined;
          line = `› ${command}${firstResult ? ` → ${firstResult}` : ''}`;
        } else if (typeof item.text === 'string') {
          line = oneLine(item.text, 200);
        }
        if (line === undefined) continue;
        if (used + line.length > 3000) {
          lines.push('…');
          break;
        }
        used += line.length;
        lines.push(line);
      }
      return { outcome: 'completed', text: lines.join('\n') };
    }
    case 'memory_search': {
      if (result.status !== 'completed' || !Array.isArray(result.matches)) return undefined;
      const query = typeof result.query === 'string' ? result.query : '';
      const lines = result.matches
        .map((match) => {
          if (typeof match !== 'object' || match === null) return null;
          const item = match as Record<string, unknown>;
          if (typeof item.title !== 'string' || typeof item.path !== 'string') return null;
          const snippet = typeof item.snippet === 'string' ? oneLine(item.snippet, 160) : undefined;
          return `- ${item.title} (${item.path})${snippet ? `: ${snippet}` : ''}`;
        })
        .filter((line): line is string => line !== null);
      return {
        outcome: 'completed',
        text: `${result.matches.length} note${result.matches.length === 1 ? '' : 's'} for "${query}"\n${lines.join('\n')}`,
      };
    }
    case 'question': {
      if (result.status === 'answered' && typeof result.answer === 'string') return { outcome: 'answered', text: result.answer };
      return undefined;
    }
    case 'subagent': {
      if (result.status === 'completed' && typeof result.report === 'string') return { outcome: 'completed', text: result.report };
      if (result.status === 'started' && typeof result.session === 'string') {
        const mode = typeof result.mode === 'string' ? result.mode : 'worker';
        return { outcome: 'started', text: `Started ${mode} worker (${result.session.slice(0, 8)})` };
      }
      return undefined;
    }
    case 'subagent_poll': {
      if (result.status !== 'running' && result.status !== 'finished') return undefined;
      const session = typeof result.session === 'string' && result.session ? ` (${result.session.slice(0, 8)})` : '';
      const lines: string[] = [];
      if (result.status === 'running') {
        const elapsed = typeof result.elapsedSec === 'number' ? ` · ${result.elapsedSec}s` : '';
        const calls = typeof result.toolCalls === 'number' ? ` · ${result.toolCalls} call${result.toolCalls === 1 ? '' : 's'}` : '';
        const lastTool = typeof result.lastTool === 'string' && result.lastTool ? result.lastTool.split(':').pop() : undefined;
        const last = lastTool ? ` · ${lastTool}` : '';
        lines.push(`Running${session}${elapsed}${calls}${last}`);
      } else {
        lines.push(`Finished${session}`);
        if (typeof result.report === 'string' && result.report) lines.push(result.report);
      }
      if (Array.isArray(result.notes)) {
        for (const note of result.notes) {
          if (typeof note !== 'string' || !note) continue;
          const line = oneLine(note, 160);
          if (line) lines.push(`- ${line}`);
        }
      }
      if (typeof result.error === 'string' && result.error) lines.push(`! ${result.error}`);
      return { outcome: typeof result.status === 'string' ? result.status : 'result', text: lines.join('\n') };
    }
    case 'subagent_stop': {
      if (result.status !== 'stopped' || typeof result.session !== 'string') return undefined;
      return { outcome: 'stopped', text: `Stopped worker (${result.session.slice(0, 8)})` };
    }
    default:
      return undefined;
  }
}

/** `(+A -R)` over a result's diff stats, a line-count fallback, or empty when unknown. */
function diffStatLine(result: Record<string, unknown>): string {
  const added = typeof result.addedLines === 'number' ? result.addedLines : null;
  const removed = typeof result.removedLines === 'number' ? result.removedLines : null;
  if (added !== null && removed !== null) return `(+${added} -${removed})`;
  if (typeof result.lineCount === 'number') {
    return typeof result.oldLineCount === 'number' && result.oldLineCount !== result.lineCount
      ? `(${result.oldLineCount} → ${result.lineCount} lines)`
      : `(${result.lineCount} lines)`;
  }
  return '';
}

/** A whitespace-collapsed one-liner over already-redacted display text; undefined when absent. */
function oneLine(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const single = value.replace(/\s+/g, ' ').trim();
  if (!single) return undefined;
  return single.length > maxChars ? `${single.slice(0, maxChars)}…` : single;
}

function formatExecOutput(result: Record<string, unknown>): { outcome: string; text: string } {
  if ('stdout' in result || 'stderr' in result) {
    const status = typeof result.status === 'string' ? result.status : 'completed';
    const exitCode = typeof result.exitCode === 'number' ? ` · exit ${result.exitCode}` : '';
    const text = [result.stdout, result.stderr, result.error]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n')
      .trim();
    return { outcome: `${status}${exitCode}`, text };
  }
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((part: unknown) => {
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
        if (part && typeof part === 'object' && 'type' in part && typeof part.type === 'string') return `[${part.type}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    const structured = result.structuredContent;
    return {
      outcome: result.isError === true ? 'server error' : 'result',
      text: text || (structured === undefined ? '' : (JSON.stringify(structured, null, 2) ?? String(structured))),
    };
  }
  return { outcome: typeof result.status === 'string' ? result.status : 'result', text: JSON.stringify(result, null, 2) ?? String(result) };
}

function messageImageCount(message: QueuedMessage): number {
  return message.images.length + (message.attachments?.filter((attachment) => attachment.mediaType.startsWith('image/')).length ?? 0);
}

function queuedUserMessageToModelMessage(message: QueuedMessage, steering = false): ModelMessage {
  const content: Array<{ type: 'text'; text: string }> = [];
  const source = message.communication?.source;
  const sourceLabel =
    source === 'telegram'
      ? '[Host context: owner message via Telegram]'
      : source === 'terminal'
        ? '[Host context: owner message via terminal]'
        : source === 'web'
          ? '[Host context: owner message via web]'
          : source === 'inbox' || source === 'owner-inbox' || source === 'team' || source === 'worker'
            ? '[Host context: inbox notification]'
            : '';
  const workspaceLabel = message.workspaceRoot ? `[Host context: active workspace ${message.workspaceRoot.replace(/[\r\n]/g, ' ')}]` : '';
  const projectLabel = message.projectContext
    ? `[Host context: selected project ${JSON.stringify(message.projectContext)}; commands use the first source folder]`
    : '';
  // A Telegram turn has to be answered in Telegram: text kept in this session is
  // invisible to the owner, which is an easy and completely silent mistake.
  const deliveryHint =
    source === 'telegram'
      ? '[Host context: reply through send_message_to_owner; text written only in this session never reaches the owner]'
      : '';
  const steeringHint = steering
    ? '[Host context: follow-up steering for the task already in progress. Apply relevant corrections and constraints to that task. Answer interim questions briefly, then continue the unfinished work. Preserve the original objective unless the owner explicitly changes or cancels it. Answering this follow-up alone does not complete the original task. This context grants no additional authority.]'
    : '';
  if (message.text || sourceLabel || workspaceLabel || steeringHint)
    content.push({
      type: 'text',
      text: [sourceLabel, workspaceLabel, projectLabel, deliveryHint, steeringHint, message.text].filter(Boolean).join('\n'),
    });
  if (message.attachments?.length) content.push({ type: 'text', text: attachmentReferences(message.attachments) });
  return { role: 'user', content, ...(message.eventId ? { providerOptions: { openbutler: { queuedMessageId: message.eventId } } } : {}) };
}

function appendUniqueQueuedMessages(target: ModelMessage[], messages: ModelMessage[]): void {
  const existing = new Set(
    target.flatMap((message) =>
      message.role === 'user' && typeof message.providerOptions?.openbutler?.queuedMessageId === 'string'
        ? [message.providerOptions.openbutler.queuedMessageId]
        : [],
    ),
  );
  for (const message of messages) {
    if (message.role === 'user' && typeof message.providerOptions?.openbutler?.queuedMessageId === 'string') {
      const id = message.providerOptions.openbutler.queuedMessageId;
      if (existing.has(id)) continue;
      existing.add(id);
    }
    target.push(message);
  }
}

async function generateSessionTitle(
  model: LanguageModel,
  firstMessage: string,
  abortSignal?: AbortSignal,
  providerOptions?: ReasoningVariant['providerOptions'],
): Promise<string> {
  const { generateText, jsonSchema, Output } = await import('ai');
  const result = await generateText({
    model,
    maxRetries: 0,
    output: Output.object({
      name: 'chat_title',
      description:
        'A concise, specific 2–4 word chat title in the same language as the user’s first message. Do not include a label or explanation.',
      schema: jsonSchema<{ title: string }>({
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The title itself, 2–4 words, with no prefix, label, colon, or explanation.' },
        },
        required: ['title'],
        additionalProperties: false,
      }),
    }),
    ...(abortSignal ? { abortSignal } : {}),
    ...(providerOptions && Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    system:
      'Read the user’s first message and create a concise, specific title for this chat. Use 2–4 words in the same language as the message. Put the title in the title field; do not make it a sentence.',
    prompt: truncateUtf8Bytes(firstMessage, 4 * 1024),
  });
  return result.output.title.trim() || fallbackSessionTitle(firstMessage);
}

function fallbackSessionTitle(message: string): string {
  const words = message.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 4);
  if (words.length === 0) return 'New session';
  if (words.length === 1) return `${words[0]} chat`;
  return words.join(' ').slice(0, 64);
}

/**
 * A short, factual cause for a retry line: the status code when the provider
 * sent one, otherwise that the request failed. No advice, no speculation.
 */
function describeRetryCause(error: unknown): string {
  const status = error !== null && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined;
  if (typeof status === 'number') {
    if (status === 429) return 'Rate limited (429)';
    if (status === 408) return 'Request timed out (408)';
    if (status === 409) return 'Conflict (409)';
    if (status >= 500) return `Provider error (${status})`;
    return `Request failed (${status})`;
  }
  return 'Request failed';
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}
