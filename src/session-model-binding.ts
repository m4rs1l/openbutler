/**
 * Role-bound session model: a private session's own view of the runtime, with
 * the model fields swapped for the role's assignment while everything shared -
 * registry, travel wiring, workspace, accounting sink, protection state -
 * stays the single runtime's.
 *
 * Why a view and not a second runtime: model state on a runtime is singular by
 * design (one conversation switches it for everybody), so sessions give the
 * model a per-session binding instead of duplicating the orchestrator. A bound
 * view is a transparent delegate - any field added to the environment later is
 * inherited automatically until someone deliberately overrides it here.
 */
import { requireModelContextWindow } from './agent-runtime.js';
import type { AgentEnvironment } from './agent-session.js';
import type { ModelState } from './model-state.js';
import { getCatalogIndex, isCatalogLoaded } from './provider/catalog.js';
import { resolveModelName, resolveProviderName } from './provider/model-presentation.js';
import {
  createLanguageModel,
  findReasoningCatalogMatch,
  listReasoningVariants,
  mergeProviderOptions,
  modelIsUsable,
  modelSupportsVision,
  normalizeReasoningVariantId,
  providerIsConfigured,
  reasoningSummaryTitles,
  reasoningSupportStatus,
  resolveReasoningVariant,
  routingProviderOptions,
  settingsEffortVariants,
  supportsImageToolResult,
  withReasoningVisibility,
} from './provider/registry.js';
import { resolveContextBudget } from './context-budget.js';
import { createPayloadFetch } from './provider/request-payload.js';
import { loadSettings, providerModelRouting, saveSettings } from './settings.js';
import { roleModelAssignment, type ModelRole } from './model-roles.js';

/**
 * Builds a private session's role view, or returns null when the role should
 * simply run on the shared runtime's model:
 * - the role has no assignment (the unconfigured case - behave as before),
 * - the assignment cannot be built or has no verified context window (a broken
 *   target degrades the session instead of taking the spawn down with it),
 * - the assignment names the runtime's current model (nothing to swap).
 *
 * The rarity matters: null is the common path, so the shared runtime never pays
 * for a role nobody used.
 */
export async function bindRoleModelView(role: ModelRole, base: AgentEnvironment): Promise<AgentEnvironment | null> {
  const settings = loadSettings();
  const assignment = roleModelAssignment(settings, role);
  if (!assignment) return null;
  if (assignment.providerId === base.providerId && assignment.modelId === base.modelId) return null;
  const provider = settings.providers[assignment.providerId];
  if (!provider?.enabled || !providerIsConfigured(assignment.providerId, provider)) return null;
  if (!modelIsUsable(settings, assignment.providerId, assignment.modelId)) return null;
  // Model activation uses the last committed local catalog, the same rule the
  // runtime's own switch follows: an expired TTL must not block a spawn.
  if (!isCatalogLoaded()) {
    try {
      await getCatalogIndex();
    } catch (error) {
      if (!provider.npm) throw error;
    }
  }
  const built = await createLanguageModel(
    assignment.providerId,
    assignment.modelId,
    provider,
    createPayloadFetch(provider, assignment.modelId),
  );
  if (!built.ok) return null;
  const catalog = findReasoningCatalogMatch(assignment.providerId, assignment.modelId, built.resolved);
  const budget = resolveContextBudget(provider.modelSpecs?.[assignment.modelId], catalog.model?.limit);
  let contextWindowTokens: number;
  try {
    contextWindowTokens = requireModelContextWindow(budget.window, assignment.providerId, assignment.modelId);
  } catch {
    return null;
  }
  const catalogVariants = listReasoningVariants(built.resolved, catalog.model);
  const variants = [
    ...catalogVariants,
    ...settingsEffortVariants(built.resolved, provider.modelSpecs?.[assignment.modelId]?.reasoning?.efforts ?? []).filter(
      (variant) => !catalogVariants.some((existing) => existing.id === variant.id),
    ),
  ];
  const reasoningDefault = resolveReasoningVariant(variants, settings.reasoning ?? 'default').id;
  const routing = routingProviderOptions(built.resolved, providerModelRouting(provider, assignment.modelId));
  // Only this model's state, and only on this view: flipping it must not touch
  // the chat session sharing the underlying runtime.
  const local = {
    supportsVision: modelSupportsVision(assignment.providerId, assignment.modelId, built.resolved),
    reasoningDefault,
  };
  // The role's model as a model state. A session asks the runtime for the
  // state of the model it wants; a role-bound session's answer is always
  // the role's model, never the shared runtime's.
  const roleState: ModelState = {
    providerId: assignment.providerId,
    modelId: assignment.modelId,
    modelName: resolveModelName(assignment.providerId, assignment.modelId),
    providerName: resolveProviderName(assignment.providerId),
    model: built.model,
    contextWindowTokens,
    outputLimitTokens: budget.output,
    get supportsVision() {
      return local.supportsVision;
    },
    get supportsImageToolResult() {
      return supportsImageToolResult(built.resolved, assignment.modelId);
    },
    reasoningVariants: variants,
    reasoningTitles: reasoningSummaryTitles(built.resolved),
    reasoningMetadataSource: catalog.inferred ? catalog.sourceProviderId : null,
    reasoningSupport: reasoningSupportStatus(built.resolved, catalog.model),
    getReasoningProviderOptions: (variantId: string, visible: boolean) => {
      const effective = resolveReasoningVariant(variants, variantId);
      return mergeProviderOptions(withReasoningVisibility(built.resolved, effective.providerOptions, visible), routing);
    },
    get registry() {
      return base.registry;
    },
  };
  const overrides: Record<string, unknown> = {
    model: built.model,
    providerId: assignment.providerId,
    modelId: assignment.modelId,
    modelName: resolveModelName(assignment.providerId, assignment.modelId),
    providerName: resolveProviderName(assignment.providerId),
    contextWindowTokens,
    outputLimitTokens: budget.output,
    get supportsVision() {
      return local.supportsVision;
    },
    set supportsVision(value: boolean) {
      local.supportsVision = value;
    },
    supportsImageToolResult: supportsImageToolResult(built.resolved, assignment.modelId),
    reasoningVariants: variants,
    reasoningMetadataSource: catalog.inferred ? catalog.sourceProviderId : null,
    reasoningSupport: reasoningSupportStatus(built.resolved, catalog.model),
    get reasoningDefault() {
      return local.reasoningDefault;
    },
    set reasoningDefault(value: string) {
      local.reasoningDefault = value;
    },
    reasoningTitles: reasoningSummaryTitles(built.resolved),
    getReasoningProviderOptions: (variantId: string, visible: boolean) => {
      const effective = resolveReasoningVariant(variants, variantId);
      return mergeProviderOptions(withReasoningVisibility(built.resolved, effective.providerOptions, visible), routing);
    },
    saveReasoningPreference: (variantId: string) => {
      saveSettings({ ...loadSettings(), reasoning: normalizeReasoningVariantId(variantId) });
      local.reasoningDefault = resolveReasoningVariant(variants, normalizeReasoningVariantId(variantId)).id;
    },
    disableImageInput: () => {
      local.supportsVision = false;
    },
    // A session asks for the state of the model it wants. A role-bound
    // session's answer is the role's model: the role decides which model
    // this session runs with, and the shared runtime's model is not it.
    modelFor: async () => roleState,
    // The role's model is the session's model; it does not switch and saved
    // conversation models do not override it - that is what "bound" means here.
    selectModel: async (nextProviderId: string, nextModelId: string) => {
      if (nextProviderId === assignment.providerId && nextModelId === assignment.modelId) return;
      throw new Error(`This session's model is fixed by its ${role} role (${assignment.providerId}/${assignment.modelId}).`);
    },
    restoreModel: async (savedProviderId: string, savedModelId: string) => {
      // A role-bound session keeps its role's model whatever pair its saved
      // transcript recorded; restore exists to bring chat sessions back.
      void savedProviderId;
      void savedModelId;
    },
  };
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      // Receiver is the base itself so inherited getters stay correct on the proxy.
      return Reflect.get(target, prop, target);
    },
    set(target, prop, value) {
      if (typeof prop === 'string' && prop in overrides) {
        overrides[prop] = value;
        return true;
      }
      return Reflect.set(target, prop, value, target);
    },
    has(target, prop) {
      if (typeof prop === 'string' && prop in overrides) return true;
      return Reflect.has(target, prop);
    },
  }) as AgentEnvironment;
}
