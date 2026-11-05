import type { ModelChoice, RuntimeInfo } from './types.js';

/** Adapts OpenButler's published model capabilities to the MindBox selector view. */
export interface ModelSelectionView {
  modelLabel: string;
  providerLabel: string;
  /** True while a picked model is remembered by the session but the server has not accepted it yet. */
  deferred: boolean;
  models: Array<{ route: ModelChoice; label: string; description: string; selected: boolean; disabled: boolean }>;
  reasoning: {
    value: string | null;
    label: string;
    description: string | null;
    options: Array<{ value: string; label: string }>;
    canSelect: boolean;
  };
  copy: {
    triggerLabel: string;
    chooseReasoning: string;
    chooseModel: string;
    back: string;
    reasoning: string;
    empty: string;
  };
}

export function modelRouteKey(runtime?: Pick<RuntimeInfo, 'providerId' | 'modelId'>) {
  return JSON.stringify([runtime?.providerId, runtime?.modelId]);
}

export function projectModelSelection(
  runtime: RuntimeInfo | undefined,
  models: ModelChoice[],
  pending?: Pick<ModelChoice, 'providerId' | 'modelId'> | null,
): ModelSelectionView | null {
  if (!runtime?.modelId || !runtime.providerId) return null;
  const runtimeRoute = modelRouteKey(runtime);
  const current = models.find((model) => modelRouteKey(model) === runtimeRoute);
  // A mid-run pick is remembered by the session but cannot reach the runtime while
  // the run blocks the switch: the projection follows the pick so the menu shows the
  // chosen model at once, while the running model stays untouched until the run ends.
  const pendingRoute = pending ? modelRouteKey(pending) : null;
  const deferred = pendingRoute !== null && pendingRoute !== runtimeRoute && models.some((model) => modelRouteKey(model) === pendingRoute);
  const chosen = deferred ? models.find((model) => modelRouteKey(model) === pendingRoute) : undefined;
  const route = deferred ? pendingRoute : runtimeRoute;
  const options = (runtime.reasoningVariants ?? []).map(({ id, label }) => ({ value: id, label }));
  const defaultOption = options.find((option) => option.value === runtime.reasoningDefault) ?? options[0];
  const modelLabel = (chosen ?? current)?.name ?? runtime.modelId;
  const label = defaultOption?.label ?? 'Default';
  return {
    modelLabel,
    providerLabel: chosen?.providerId ?? runtime.providerId,
    deferred,
    models: models.map((model) => ({
      route: model,
      label: model.name,
      description: model.providerId,
      selected: modelRouteKey(model) === route,
      disabled: false,
    })),
    reasoning: {
      value: defaultOption?.value ?? null,
      label,
      description: null,
      options,
      canSelect: options.length > 1,
    },
    copy: {
      triggerLabel: modelLabel,
      chooseReasoning: 'Choose reasoning effort',
      chooseModel: 'Choose model',
      back: 'Back',
      reasoning: 'Reasoning effort',
      empty: 'No models are configured.',
    },
  };
}
