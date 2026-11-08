import {
  findReasoningCatalogMatch,
  listReasoningVariants,
  resolveProvider,
  resolveReasoningVariant,
  settingsEffortVariants,
  type ReasoningVariant,
  type ResolvedProvider,
} from './registry.js';

/** The provider entry as settings holds it; only these fields are read here. */
export interface ModelEffortProvider {
  npm?: string;
  url?: string;
  keys?: string[];
  options?: Record<string, unknown>;
  modelSpecs?: Record<string, { reasoning?: { efforts?: string[] } }>;
}

/**
 * The effort levels one model offers, computed without activating it.
 *
 * This is the single source of truth for a model's reasoning list: the runtime
 * uses it when a model becomes active, and the web surface uses it to show a
 * model the owner has picked but not yet switched to. Both must agree, or the
 * picker offers levels the model will not take.
 */
export function modelReasoningVariants(
  providerId: string,
  modelId: string,
  resolved: ResolvedProvider,
  efforts: readonly string[] = [],
): ReasoningVariant[] {
  const catalog = findReasoningCatalogMatch(providerId, modelId, resolved);
  const catalogVariants = listReasoningVariants(resolved, catalog.model);
  if (efforts.length === 0) return catalogVariants;
  return [
    ...catalogVariants,
    ...settingsEffortVariants(resolved, efforts).filter((variant) => !catalogVariants.some((existing) => existing.id === variant.id)),
  ];
}

/**
 * The same list for a model that is only being *offered*, before any switch.
 *
 * Resolving the provider is pure catalog/settings work - no network, no model
 * instance - so a picker can ask about any configured model cheaply. Returns
 * null when the provider cannot be resolved at all, which is the caller's
 * signal to keep what it already shows instead of guessing.
 */
export function describeModelReasoning(
  providerId: string,
  modelId: string,
  provider: ModelEffortProvider,
  preferredEffort?: string,
): { variants: ReasoningVariant[]; defaultVariantId: string } | null {
  const resolution = resolveProvider(providerId, provider);
  if (!resolution.ok) return null;
  const variants = modelReasoningVariants(
    providerId,
    modelId,
    resolution.provider,
    provider.modelSpecs?.[modelId]?.reasoning?.efforts ?? [],
  );
  return {
    variants,
    defaultVariantId: resolveReasoningVariant(variants, preferredEffort ?? 'default').id,
  };
}
