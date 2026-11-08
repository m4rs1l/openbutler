import { expect, it } from 'vitest';
import type { AgentEnvironment } from '../src/agent-session.js';
import { toRuntimeView } from '../src/daemon-host.js';
import { ToolRegistry } from '../src/tools/registry.js';

/**
 * The published runtime view is what every client renders its model and effort
 * pickers from. The session is the authority for those two values, so the view
 * must answer with the session's own choice even while the shared runtime is
 * still bound to another session's model.
 */
function runtimeFor(): AgentEnvironment {
  return {
    model: {} as AgentEnvironment['model'],
    workspaceRoot: process.cwd(),
    modelName: 'Fixture model',
    providerName: 'Fixture',
    providerId: 'fixture',
    modelId: 'fixture-a',
    contextWindowTokens: 128_000,
    outputLimitTokens: null,
    supportsVision: false,
    supportsImageToolResult: false,
    reasoningVariants: [],
    reasoningMetadataSource: null,
    reasoningSupport: 'model-unsupported',
    reasoningDefault: 'default',
    reasoningPreference: 'default',
    saveReasoningPreference: () => {},
    showReasoningDefault: true,
    saveShowReasoningPreference: () => {},
    getReasoningProviderOptions: () => ({}),
    getReviewProviderOptions: () => ({}),
    registry: new ToolRegistry(),
    selectModel: async () => {},
    close: async () => {},
  };
}

it('answers with the session own model and effort instead of the shared runtime', () => {
  const runtime = runtimeFor();
  const view = toRuntimeView(runtime, runtime.workspaceRoot, {
    providerId: 'other',
    modelId: 'other-model',
    reasoning: 'high',
    showReasoning: false,
    contextWindowTokens: 64_000,
  });
  expect(view.providerId).toBe('other');
  expect(view.modelId).toBe('other-model');
  expect(view.reasoningDefault).toBe('high');
  expect(view.showReasoningDefault).toBe(false);
  expect(view.contextWindowTokens).toBe(64_000);
  // An id the catalog does not know resolves to itself, never to the
  // runtime's active model name.
  expect(view.modelName).toBe('other-model');
  expect(view.providerName).toBe('other');

  // The runtime itself is only the engine: nothing written to the view
  // mutates it.
  expect(runtime.modelId).toBe('fixture-a');
  expect(runtime.reasoningDefault).toBe('default');
});

it('falls back to the runtime while the session carries no choice of its own', () => {
  const runtime = runtimeFor();
  const view = toRuntimeView(runtime);
  expect(view.providerId).toBe('fixture');
  expect(view.modelId).toBe('fixture-a');
  expect(view.modelName).toBe('Fixture model');
  expect(view.reasoningDefault).toBe('default');
  expect(view.showReasoningDefault).toBe(true);
  expect(view.contextWindowTokens).toBe(128_000);
});

it('drops a recorded effort the chat own list does not offer', () => {
  const runtime = runtimeFor();
  const view = toRuntimeView(runtime, runtime.workspaceRoot, {
    providerId: 'other',
    modelId: 'other-model',
    reasoning: 'high',
    reasoningVariants: [
      { id: 'default', label: 'Default' },
      { id: 'minimal', label: 'Minimal' },
    ],
  });
  // The list proves this chat's model has no `high`, so reporting it would leave
  // the picker on a value nothing can submit again.
  expect(view.reasoningVariants.map((variant) => variant.id)).not.toContain('high');
  expect(view.reasoningVariants.map((variant) => variant.id)).toContain(view.reasoningDefault);
  expect(view.reasoningDefault).not.toBe('high');
});
