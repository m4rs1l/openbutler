import type { InboxRequest } from './inbox.js';
import type { ParentMessageInput } from './worker-records.js';
import { canonicalScopeRoot as canonicalWorkspaceRoot } from './workspace-origin.js';
import { resolveContextBudget } from './context-budget.js';
import type { LanguageModel } from 'ai';
import { getCatalogIndex, getCatalogRevision, isCatalogLoaded } from './provider/catalog.js';
import { resolveModelName, resolveProviderName } from './provider/model-presentation.js';
import {
  createLanguageModel,
  defaultModelIsUsable,
  findReasoningCatalogMatch,
  mergeProviderOptions,
  minimalReasoningOptions,
  modelInputModalities,
  modelIsUsable,
  modelSupportsVision,
  normalizeReasoningVariantId,
  providerIsConfigured,
  reasoningSummaryTitles,
  reasoningSupportStatus,
  resolveReasoningVariant,
  routingProviderOptions,
  supportsImageToolResult,
  type ReasoningVariant,
  type ResolvedProvider,
  withReasoningVisibility,
} from './provider/registry.js';
import { modelReasoningVariants } from './provider/model-view.js';
import { createPayloadFetch } from './provider/request-payload.js';
import { resolveRoleModel, roleModelAssignment, roleModelConfig, type ModelRole } from './model-roles.js';
import {
  loadSettings,
  providerModelRouting,
  rememberProviderModel,
  saveSettings,
  type ApprovalMode,
  type SettingsStore,
} from './settings.js';
import type { RetryEvent } from './provider/retry.js';
import type { AgentEnvironment } from './agent-session.js';
import type { UsageRecordInput } from './usage/recorder.js';
import type { SubagentRequest } from './tools/subagent.js';
import type { McpConnectionManager } from './tools/mcp.js';
import { createSendMessageToOwnerTool } from './tools/owner-communication.js';
import { createCustodianMessageTool } from './tools/custodian-message.js';
import { createSessionMessageTool } from './tools/session-message.js';
import { createWorkerMessageTool } from './tools/worker-message.js';
import { createApprovalDecideTool } from './tools/approval-decide.js';
import { createSessionNewTool } from './tools/session-new.js';
import { createTeamProfileTool, createTeamWorkTool } from './tools/team-coordination.js';
import {
  createTeamDeliveryTool,
  createTeamFilesTool,
  createTeamGroupTool,
  createTeamHistoryTool,
  createTeamReceiveFileTool,
  createTeamSendFileTool,
  createTeamSendTool,
  createTeamStatusTool,
} from './tools/team-communication.js';

/** A session cannot manage its context safely without a verified model limit.
 * Never silently invent an arbitrary 8k/32k window for unknown providers.
 */
export function requireModelContextWindow(value: number | null | undefined, providerId: string, modelId: string): number {
  if (value === undefined || value === null || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `The context limit for ${providerId}/${modelId} is unknown. Configure providers.${providerId}.modelSpecs.${modelId}.context in settings, or choose a cataloged model. Automatic compaction requires an explicit model context limit.`,
    );
  }
  return value;
}

export interface CreateAgentRuntimeOptions {
  workspaceRoot?: string;
  /**
   * Which role this runtime serves. The role decides the starting model when no
   * conversation model was saved: chat runtimes bind `agent`, the head's own
   * runtime binds `custodian`. Worker and background roles never get a runtime -
   * they bind their model at the session level over the shared one.
   */
  role?: Exclude<ModelRole, 'worker' | 'background' | 'title' | 'review'>;
  /** Restore a conversation's model without changing the machine's defaults. */
  initialModel?: { providerId: string; modelId: string };
  /**
   * The head's configured compaction budget, as a function so it is read at the
   * compaction decision rather than frozen when the runtime was built. Only the
   * custodian runtime is given one.
   */
  custodianContextLimitTokens?: () => number | undefined;
  /** Interactive chats open before external tools connect; the first turn prepares them. */
  deferMcp?: boolean;
  /** Borrowed from the daemon; closing a chat never closes shared transports. */
  mcpManager?: McpConnectionManager;
  onMcpError?: (serverId: string, message: string) => void;
  onMcpConnected?: (serverId: string, toolCount: number) => void;
  backgroundManage?: (input: Record<string, unknown>, workspaceRoot: string, senderSessionId: string | undefined) => Promise<unknown>;
  inbox?: (request: InboxRequest, sessionId: string | undefined) => Promise<unknown>;
  /** Owner-channel writer. Only the custodian runtime is given one, and its presence is what registers the tool. */
  ownerMessageSend?: (input: Record<string, unknown>, workspaceRoot: string) => Promise<unknown>;
  /**
   * Team surface. The custodian runtime is the only one given these, and a
   * handler's presence is what registers its tool: the peers are other machines'
   * heads, so a chat or a worker holding one would speak for this machine.
   */
  teamDelivery?: (input: Record<string, unknown>) => Promise<unknown>;
  teamSend?: (input: { recipient: string; text: string; replyTo?: string }) => Promise<unknown>;
  teamGroup?: (limit: number, acknowledge?: number) => Promise<unknown>;
  teamHistory?: (query: { scope: 'group' | 'dm'; peer?: string; before?: number; limit?: number }) => Promise<unknown>;
  teamStatus?: () => Promise<unknown>;
  teamSendFile?: (input: { path: string; to: string }) => Promise<unknown>;
  teamReceiveFile?: (input: { id: string; to?: string }) => Promise<unknown>;
  teamFiles?: () => Promise<unknown>;
  teamProfile?: (input: Record<string, unknown>) => Promise<unknown>;
  teamWork?: (input: Record<string, unknown>) => Promise<unknown>;
  /** A session's channel to the head. Supplied to session runtimes only. */
  custodianMessage?: (
    input: { text: string; kind: 'progress' | 'result' },
    senderSessionId: string | undefined,
  ) => Promise<unknown> | unknown;
  /** The head's way into a chat. Supplied to the custodian runtime only. */
  sessionMessage?: (input: Record<string, unknown>, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  /** The head's verb for a delegated approval. Supplied to the custodian runtime only. */
  approvalDecide?: (input: { requestId: string; decision: 'allow' | 'deny' }, senderSessionId: string | undefined) => unknown;
  /** The head's way to start a durable chat. Supplied to the custodian runtime only. */
  sessionNew?: (input: { instruction: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  /** Steering a live worker. Supplied wherever a runtime may own one. */
  workerMessage?: (input: { session: string; text: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  subagent?: (request: SubagentRequest, senderSessionId: string | undefined, signal?: AbortSignal) => Promise<unknown> | unknown;
  parentMessage?: (input: ParentMessageInput, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  subagentStop?: (input: { session: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown;
  /** Writes one accounting row per model request; supplied by whoever owns the ledger. */
  recordUsage?: (input: UsageRecordInput, id: string) => void;
}

/** Creates the shared model/tool runtime without depending on a terminal UI. */
export async function createAgentRuntime(options: CreateAgentRuntimeOptions = {}): Promise<AgentEnvironment> {
  const settings = loadSettings();
  // A session's initial model wins; otherwise this runtime's role decides: its
  // assignment when the owner made one, else the explicit default or, when that
  // is unset too, the most-used usable model from recorded usage.
  const defaultChoice = options.initialModel ?? resolveRoleModel(settings, options.role ?? 'agent');
  const providerId = defaultChoice?.providerId ?? '';
  const modelId = defaultChoice?.modelId ?? '';
  const provider = settings.providers[providerId];
  if (!providerId || !modelId || !provider?.enabled || !providerIsConfigured(providerId, provider)) {
    throw new Error('No ready default provider and model. Run `openbutler setup` first.');
  }

  const { MemoryIndex, isMemoryEmbeddingModelPrepared } = await import('./memory-index.js');
  if (!(await isMemoryEmbeddingModelPrepared().catch(() => false))) {
    const { ensureMemoryModelPreparation } = await import('./memory-model-preparation.js');
    ensureMemoryModelPreparation();
  }

  if (!provider.npm) await getCatalogIndex();
  else {
    try {
      await getCatalogIndex();
    } catch {
      // Custom endpoints remain usable when models.dev is unavailable.
    }
  }

  if (!defaultModelIsUsable({ ...settings, defaultProvider: providerId, defaultModel: modelId })) {
    throw new Error('The default model is not ready. Configure its provider and model: openbutler setup');
  }
  // Retry and key-rotation events surface through here so the session can show
  // them in the transcript; the handler is swapped per run.
  const retryRelay: { handler: ((event: RetryEvent) => void) | null } = { handler: null };
  const reportRetry = (event: RetryEvent) => retryRelay.handler?.(event);

  const resolved = await createLanguageModel(providerId, modelId, provider, createPayloadFetch(provider, modelId), reportRetry);
  if (!resolved.ok) throw new Error(resolved.error.reason);
  const reasoningCatalog = findReasoningCatalogMatch(providerId, modelId, resolved.resolved);
  // An explicit settings window is authoritative over the catalog: the owner may
  // cap a model below its advertised limit or give a model the catalog lacks one.
  // One resolver decides window and output together so the two can never read
  // opposite orderings at the same call site.
  const budget = resolveContextBudget(provider.modelSpecs?.[modelId], reasoningCatalog.model?.limit);
  const contextWindowTokens = requireModelContextWindow(budget.window, providerId, modelId);
  const reasoningVariants = modelReasoningVariants(
    providerId,
    modelId,
    resolved.resolved,
    provider.modelSpecs?.[modelId]?.reasoning?.efforts ?? [],
  );

  async function loadReviewer(latest: SettingsStore): Promise<{
    resolved: ResolvedProvider | null;
    catalogModel: typeof reasoningCatalog.model;
    model: LanguageModel | null;
    routing: ReturnType<typeof routingProviderOptions>;
  }> {
    // The review role resolves the same way every role does; the legacy
    // autoReview pair is read through the resolver, so the old settings and a
    // roles.review entry are one code path.
    const assignment = roleModelAssignment(latest, 'review');
    if (!assignment) return { resolved: null, catalogModel: null, model: null, routing: {} };
    if (!modelIsUsable(latest, assignment.providerId, assignment.modelId))
      throw new Error('The configured auto-review provider/model is not ready.');
    const built = await createLanguageModel(
      assignment.providerId,
      assignment.modelId,
      latest.providers[assignment.providerId],
      createPayloadFetch(latest.providers[assignment.providerId], assignment.modelId),
    );
    if (!built.ok) throw new Error(built.error.reason);
    return {
      resolved: built.resolved,
      catalogModel: findReasoningCatalogMatch(assignment.providerId, assignment.modelId, built.resolved).model,
      model: built.model,
      routing: routingProviderOptions(built.resolved, providerModelRouting(latest.providers[assignment.providerId], assignment.modelId)),
    };
  }
  const reviewerConfig = (latest: SettingsStore) => JSON.stringify([roleModelConfig(latest, 'review'), getCatalogRevision()]);
  let reviewer = await loadReviewer(settings);
  let appliedReviewerConfig = reviewerConfig(settings);

  // The title generation clerk runs on the `title` role's model when one is
  // assigned; without an assignment it is absent and a session falls back to
  // its main model, which is the behaviour every chat had before roles existed.
  const titleConfig = (latest: SettingsStore) => JSON.stringify([roleModelConfig(latest, 'title'), getCatalogRevision()]);
  async function loadTitleClerk(latest: SettingsStore): Promise<{
    model: LanguageModel | null;
    providerOptions: ReasoningVariant['providerOptions'] | null;
  }> {
    const assignment = roleModelAssignment(latest, 'title');
    // Unlike the reviewer, a broken title target is not an error: naming a chat
    // is a convenience, and it must never fail a run the way a missing reviewer can.
    if (!assignment || !modelIsUsable(latest, assignment.providerId, assignment.modelId)) return { model: null, providerOptions: null };
    const built = await createLanguageModel(
      assignment.providerId,
      assignment.modelId,
      latest.providers[assignment.providerId],
      createPayloadFetch(latest.providers[assignment.providerId], assignment.modelId),
    );
    if (!built.ok) return { model: null, providerOptions: null };
    return {
      model: built.model,
      providerOptions: mergeProviderOptions(
        minimalReasoningOptions(
          built.resolved,
          findReasoningCatalogMatch(assignment.providerId, assignment.modelId, built.resolved).model,
        ) ?? {},
        routingProviderOptions(built.resolved, providerModelRouting(latest.providers[assignment.providerId], assignment.modelId)),
      ),
    };
  }
  let titleClerk = await loadTitleClerk(settings);
  let appliedTitleConfig = titleConfig(settings);
  let workspaceRoot = canonicalWorkspaceRoot(options.workspaceRoot ?? process.cwd());
  const { ToolRegistry } = await import('./tools/registry.js');
  let memoryIndex = new MemoryIndex(workspaceRoot);
  let workspaceSwitch = Promise.resolve();
  let activeInputModalities = modelInputModalities(providerId, modelId, resolved.resolved);
  let mcp: Awaited<ReturnType<(typeof import('./tools/mcp.js'))['connectMcpServers']>> | null = null;
  let mcpReady = options.mcpManager ? false : options.deferMcp !== true;

  try {
    const [{ connectMcpServers }, { createToolCatalogue }] = await Promise.all([import('./tools/mcp.js'), import('./tools/catalog.js')]);
    mcp =
      options.mcpManager ??
      (await connectMcpServers(mcpReady ? settings.mcpServers : {}, {
        onError: options.onMcpError ?? (() => {}),
        onConnected: options.onMcpConnected ?? (() => {}),
        inputModalities: () => activeInputModalities,
      }));
    function createRegistry(inputModalities: readonly string[], scopeRoot = workspaceRoot, scopeMemoryIndex = memoryIndex) {
      const registry = new ToolRegistry();
      for (const definition of createToolCatalogue({
        workspaceRoot: scopeRoot,
        inputModalities,
        memoryIndex: scopeMemoryIndex,
        mcp: mcp!,
        onMcpConnectionsChanged: () => {
          runtime.registry = createRegistry(activeInputModalities);
        },
        ...(options.backgroundManage ? { backgroundManage: options.backgroundManage } : {}),
        ...(options.inbox ? { inbox: options.inbox } : {}),
        ...(options.subagent ? { subagent: options.subagent } : {}),
        ...(options.subagentStop ? { subagentStop: options.subagentStop } : {}),
      })) {
        registry.register(definition);
      }
      // Messaging tools are named after their addressee and none of them is in the
      // shared catalogue: a runtime registers the ones it is handed a handler for.
      // That is the layer table in one place - a chat holds custodian_message and
      // worker_message, the head holds session_message and worker_message, and a
      // worker's registry is built by the host with parent_message instead.
      if (options.ownerMessageSend) registry.register(createSendMessageToOwnerTool(scopeRoot, options.ownerMessageSend));
      if (options.sessionMessage) registry.register(createSessionMessageTool(options.sessionMessage));
      if (options.custodianMessage) registry.register(createCustodianMessageTool(options.custodianMessage));
      if (options.workerMessage) registry.register(createWorkerMessageTool(options.workerMessage));
      if (options.approvalDecide) registry.register(createApprovalDecideTool(options.approvalDecide));
      if (options.sessionNew) registry.register(createSessionNewTool(options.sessionNew));
      // The team surface belongs to the head alone. A peer is another machine's
      // custodian, so a chat or a worker that could address one would speak for
      // this machine without standing behind what it promised, and the peer could
      // not tell which layer had spoken.
      if (options.teamDelivery) registry.register(createTeamDeliveryTool(options.teamDelivery));
      if (options.teamSend) registry.register(createTeamSendTool(options.teamSend));
      if (options.teamGroup) registry.register(createTeamGroupTool(options.teamGroup));
      if (options.teamHistory) registry.register(createTeamHistoryTool(options.teamHistory));
      if (options.teamStatus) registry.register(createTeamStatusTool(options.teamStatus));
      if (options.teamSendFile) registry.register(createTeamSendFileTool(options.teamSendFile));
      if (options.teamReceiveFile) registry.register(createTeamReceiveFileTool(options.teamReceiveFile));
      if (options.teamFiles) registry.register(createTeamFilesTool(options.teamFiles));
      if (options.teamProfile) registry.register(createTeamProfileTool(options.teamProfile));
      if (options.teamWork) registry.register(createTeamWorkTool(options.teamWork));
      return registry;
    }
    let activeResolved = resolved.resolved;
    let activeCatalog = reasoningCatalog;
    let activeVariants = reasoningVariants;
    let activeRouting = routingProviderOptions(resolved.resolved, providerModelRouting(provider, modelId));
    const modelConfig = (latest: SettingsStore) =>
      JSON.stringify([runtime.providerId, runtime.modelId, latest.providers[runtime.providerId], getCatalogRevision()]);
    let appliedModelConfig = JSON.stringify([providerId, modelId, provider, getCatalogRevision()]);
    let settingsReload = Promise.resolve();
    let appliedMcpRevision = mcp.revision;
    let runtimeClosed = false;
    async function applyModel(nextSettings: SettingsStore, nextProviderId: string, nextModelId: string) {
      const nextProvider = nextSettings.providers[nextProviderId];
      // Model activation uses the last committed local catalog. An expired TTL
      // must not make a session switch wait for the network refresh timeout.
      if (!isCatalogLoaded()) {
        try {
          await getCatalogIndex();
        } catch (error) {
          if (!nextProvider?.npm) throw error;
        }
      }
      if (!modelIsUsable(nextSettings, nextProviderId, nextModelId))
        throw new Error(`Provider ${nextProviderId} is disabled or not configured.`);
      const next = await createLanguageModel(
        nextProviderId,
        nextModelId,
        nextProvider,
        createPayloadFetch(nextProvider, nextModelId),
        reportRetry,
      );
      if (!next.ok) throw new Error(next.error.reason);
      const nextCatalog = findReasoningCatalogMatch(nextProviderId, nextModelId, next.resolved);
      const nextBudget = resolveContextBudget(nextProvider.modelSpecs?.[nextModelId], nextCatalog.model?.limit);
      const nextContextWindowTokens = requireModelContextWindow(nextBudget.window, nextProviderId, nextModelId);
      const nextVariants = modelReasoningVariants(
        nextProviderId,
        nextModelId,
        next.resolved,
        nextProvider.modelSpecs?.[nextModelId]?.reasoning?.efforts ?? [],
      );
      const nextInputModalities = modelInputModalities(nextProviderId, nextModelId, next.resolved);
      const nextRegistry = createRegistry(nextInputModalities);

      activeResolved = next.resolved;
      activeCatalog = nextCatalog;
      activeVariants = nextVariants;
      activeRouting = routingProviderOptions(next.resolved, providerModelRouting(nextProvider, nextModelId));
      activeInputModalities = nextInputModalities;
      runtime.model = next.model;
      runtime.modelName = resolveModelName(nextProviderId, nextModelId);
      runtime.providerName = resolveProviderName(nextProviderId);
      runtime.providerId = nextProviderId;
      runtime.modelId = nextModelId;
      runtime.contextWindowTokens = nextContextWindowTokens;
      runtime.outputLimitTokens = nextBudget.output;
      runtime.supportsVision = modelSupportsVision(nextProviderId, nextModelId, next.resolved);
      runtime.supportsImageToolResult = supportsImageToolResult(next.resolved, nextModelId);
      runtime.reasoningVariants = nextVariants;
      runtime.reasoningTitles = reasoningSummaryTitles(next.resolved);
      runtime.reasoningMetadataSource = nextCatalog.inferred ? nextCatalog.sourceProviderId : null;
      runtime.reasoningSupport = reasoningSupportStatus(next.resolved, nextCatalog.model);
      runtime.reasoningDefault = resolveReasoningVariant(nextVariants, nextSettings.reasoning ?? 'default').id;
      runtime.registry = nextRegistry;
      appliedModelConfig = modelConfig(nextSettings);
    }
    const runtime: AgentEnvironment = {
      model: resolved.model,
      ...(reviewer.model ? { reviewModel: reviewer.model } : {}),
      ...(titleClerk.model ? { titleModel: titleClerk.model } : {}),
      getTitleProviderOptions: () => titleClerk.providerOptions ?? {},
      get workspaceRoot() {
        return workspaceRoot;
      },
      modelName: resolveModelName(providerId, modelId),
      providerName: resolveProviderName(providerId),
      providerId,
      modelId,
      contextWindowTokens,
      // Read at the compaction decision, not frozen when the runtime was built: the
      // owner may change the budget without restarting the host.
      get custodianContextLimitTokens() {
        return options.custodianContextLimitTokens?.();
      },
      outputLimitTokens: budget.output,
      supportsVision: modelSupportsVision(providerId, modelId, activeResolved),
      supportsImageToolResult: supportsImageToolResult(resolved.resolved, modelId),
      disableImageInput: () => {
        runtime.supportsVision = false;
        if (!activeInputModalities.includes('image')) return;
        const nextInputModalities = activeInputModalities.filter((modality) => modality !== 'image');
        const nextRegistry = createRegistry(nextInputModalities);
        activeInputModalities = nextInputModalities;
        runtime.registry = nextRegistry;
      },
      reasoningVariants,
      reasoningTitles: reasoningSummaryTitles(resolved.resolved),
      reasoningMetadataSource: activeCatalog.inferred ? activeCatalog.sourceProviderId : null,
      reasoningSupport: reasoningSupportStatus(resolved.resolved, reasoningCatalog.model),
      reasoningDefault: resolveReasoningVariant(reasoningVariants, settings.reasoning ?? 'default').id,
      saveReasoningPreference: (variantId) => {
        const latest = loadSettings();
        latest.reasoning = normalizeReasoningVariantId(variantId);
        saveSettings(latest);
        runtime.reasoningDefault = resolveReasoningVariant(activeVariants, latest.reasoning).id;
      },
      showReasoningDefault: settings.showReasoning !== false,
      approvalMode: settings.approvalMode,
      saveApprovalModePreference: (mode: ApprovalMode) => {
        const latest = loadSettings();
        latest.approvalMode = mode;
        saveSettings(latest);
        runtime.approvalMode = mode;
      },
      reportRetry: (handler) => {
        retryRelay.handler = handler;
      },
      saveShowReasoningPreference: (visible) => {
        const latest = loadSettings();
        latest.showReasoning = visible;
        saveSettings(latest);
        runtime.showReasoningDefault = visible;
      },
      getReasoningProviderOptions: (variantId, visible) => {
        const effective = resolveReasoningVariant(activeVariants, variantId);
        return mergeProviderOptions(withReasoningVisibility(activeResolved, effective.providerOptions, visible), activeRouting);
      },
      getReviewProviderOptions: () =>
        mergeProviderOptions(
          reviewer.resolved
            ? (minimalReasoningOptions(reviewer.resolved, reviewer.catalogModel) ?? {})
            : (minimalReasoningOptions(activeResolved, activeCatalog.model) ?? {}),
          reviewer.resolved ? reviewer.routing : activeRouting,
        ),
      registry: createRegistry(activeInputModalities),
      ...(options.recordUsage ? { recordUsage: options.recordUsage } : {}),

      getPeerCapabilities: () => ({
        platform: process.platform,
        mcpServers: mcp!
          .list()
          .filter((server) => server.connected)
          .map((server) => ({ name: server.id, toolCount: server.toolCount })),
        mcpTools: mcp!.tools.map((tool) => `${tool.providerId}/${tool.name}`),
      }),
      selectWorkspaceRoot: async (path) => {
        const run = workspaceSwitch.then(async () => {
          const nextRoot = canonicalWorkspaceRoot(path);
          if (nextRoot === workspaceRoot) return;
          const nextMemoryIndex = new MemoryIndex(nextRoot);
          let nextRegistry: ReturnType<typeof createRegistry>;
          try {
            nextRegistry = createRegistry(activeInputModalities, nextRoot, nextMemoryIndex);
          } catch (error) {
            await nextMemoryIndex.close();
            throw error;
          }
          const previousMemoryIndex = memoryIndex;
          workspaceRoot = nextRoot;
          memoryIndex = nextMemoryIndex;
          runtime.registry = nextRegistry;
          await previousMemoryIndex.close();
        });
        workspaceSwitch = run.catch(() => {});
        await run;
      },
      restoreModel: async (nextProviderId, nextModelId) => {
        const restore = settingsReload.then(async () => {
          if (runtimeClosed) throw new Error('The runtime is closed.');
          if (runtime.providerId === nextProviderId && runtime.modelId === nextModelId) return;
          await applyModel(loadSettings(), nextProviderId, nextModelId);
        });
        settingsReload = restore.catch(() => {});
        await restore;
      },
      selectModel: async (nextProviderId, nextModelId) => {
        const select = settingsReload.then(async () => {
          if (runtimeClosed) throw new Error('The runtime is closed.');
          const latest = loadSettings();
          await applyModel(latest, nextProviderId, nextModelId);
          // A selection belongs to this session: the global default changes only
          // through the explicit settings commands, never by picking a model.
          rememberProviderModel(latest, latest.defaultProvider, latest.defaultModel);
          rememberProviderModel(latest, nextProviderId, nextModelId);
          saveSettings(latest);
        });
        settingsReload = select.catch(() => {});
        await select;
      },
      prepareForTurn: async () => {
        if (mcpReady) return;
        mcpReady = true;
        try {
          await runtime.reloadSettings!(true);
        } catch (error) {
          mcpReady = false;
          throw error;
        }
      },
      reloadSettings: (reloadTools = false) => {
        const reload = settingsReload.then(async () => {
          if (runtimeClosed) return;
          const latest = loadSettings();
          // Validate/build before publishing new model state. An invalid edit never
          // overwrites the files or silently falls back to removed credentials.
          const nextReviewerConfig = reviewerConfig(latest);
          const nextReviewer = nextReviewerConfig === appliedReviewerConfig ? reviewer : await loadReviewer(latest);
          if (modelConfig(latest) !== appliedModelConfig) await applyModel(latest, runtime.providerId, runtime.modelId);
          reviewer = nextReviewer;
          appliedReviewerConfig = nextReviewerConfig;
          if (reviewer.model) runtime.reviewModel = reviewer.model;
          else delete runtime.reviewModel;
          const nextTitleConfig = titleConfig(latest);
          if (nextTitleConfig !== appliedTitleConfig) {
            titleClerk = await loadTitleClerk(latest);
            appliedTitleConfig = nextTitleConfig;
            if (titleClerk.model) runtime.titleModel = titleClerk.model;
            else delete runtime.titleModel;
          }
          runtime.reasoningDefault = resolveReasoningVariant(activeVariants, latest.reasoning ?? 'default').id;
          runtime.showReasoningDefault = latest.showReasoning !== false;
          runtime.approvalMode = latest.approvalMode;
          const toolsChanged = reloadTools && mcpReady && (await mcp!.reload(latest.mcpServers));
          if (toolsChanged || mcp!.revision !== appliedMcpRevision) {
            runtime.registry = createRegistry(activeInputModalities);
            appliedMcpRevision = mcp!.revision;
          }
        });
        settingsReload = reload.catch(() => {});
        return reload;
      },
      close: async () => {
        runtimeClosed = true;
        await settingsReload;
        try {
          await memoryIndex.close();
        } finally {
          if (!options.mcpManager) await mcp?.close();
        }
      },
    };
    return runtime;
  } catch (error) {
    try {
      await memoryIndex.close();
    } finally {
      if (!options.mcpManager) await mcp?.close();
    }
    throw error;
  }
}
