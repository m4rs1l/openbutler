/**
 * A model's own state, independent of any runtime that happens to run it.
 *
 * Why this exists: a runtime used to carry ONE "current model" for everybody
 * sharing it, so a chat that switched models moved the workspace's model with
 * it - every other chat, the custodian, a worker and the scheduler saw the
 * switch. A model state is the alternative: the runtime builds one per
 * (provider, model) pair and hands it to whoever asked, so the model a chat
 * runs with belongs to that chat and nobody else.
 *
 * The state is what a request is actually made with: the model instance, the
 * effort levels the model offers, the provider options an effort maps to, the
 * context window and the tool catalogue for the model's input modalities.
 */
import type { LanguageModel } from 'ai';
import type { ReasoningSupport, ReasoningVariant } from './provider/registry.js';
import type { ToolRegistry } from './tools/registry.js';

export interface ModelState {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly providerName: string;
  readonly model: LanguageModel;
  readonly contextWindowTokens: number | null;
  readonly outputLimitTokens: number | null;
  readonly supportsVision: boolean;
  readonly supportsImageToolResult: boolean;
  /** The effort levels this model offers, in the order the picker shows them. */
  readonly reasoningVariants: ReasoningVariant[];
  readonly reasoningTitles: boolean;
  readonly reasoningMetadataSource: string | null;
  readonly reasoningSupport: ReasoningSupport;
  /** The provider options an effort maps to on THIS model. */
  readonly getReasoningProviderOptions: (variantId: string, visible: boolean) => ReasoningVariant['providerOptions'];
  /**
   * The provider options fragment naming this chat's conversation to a gateway
   * that supports session affinity; absent where the provider documents none.
   */
  readonly sessionAffinityProviderOptions?: (sessionId: string) => ReasoningVariant['providerOptions'];
  /** The tool catalogue for this model's input modalities. */
  readonly registry: ToolRegistry;
}

/** The key a model state is cached under. */
export function modelStateKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}
