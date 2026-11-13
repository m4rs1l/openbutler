import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { jsonSchema, tool } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ build: vi.fn(), connectMcp: vi.fn(), reloadMcp: vi.fn(async () => false) }));
vi.mock('../src/memory-index.js', () => ({
  MemoryIndex: class {
    async close() {}
  },
  isMemoryEmbeddingModelPrepared: async () => true,
}));
vi.mock('../src/tools/catalog.js', () => ({ createToolCatalogue: () => [] }));
vi.mock('../src/tools/mcp.js', () => ({
  connectMcpServers: async (servers: unknown) => {
    calls.connectMcp(servers);
    return { tools: [], list: () => [], close: async () => {}, reload: calls.reloadMcp };
  },
}));

function response(reason: 'stop' | 'tool-calls') {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        if (reason === 'tool-calls')
          controller.enqueue({ type: 'tool-call', toolCallId: 'refresh', toolName: 'changeSettings', input: '{}' });
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: reason, raw: reason },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        });
        controller.close();
      },
    }),
  };
}

let directory: string;
let runtime: import('../src/agent-session.js').AgentEnvironment;
let settings: typeof import('../src/settings.js');
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'openbutler-live-settings-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', directory);
  vi.resetModules();
  vi.clearAllMocks();
  // Recreate the partial mock with this test's catalog module and data directory.
  vi.doMock('../src/provider/registry.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/provider/registry.js')>();
    return {
      ...actual,
      createLanguageModel: async (id: string, modelId: string, state: import('../src/settings.js').ProviderState) => {
        calls.build(id, modelId, state);
        const result = actual.resolveProvider(id, state);
        if (!result.ok) return result;
        return { ok: true, model: new MockLanguageModelV3({ modelId, doStream: async () => response('stop') }), resolved: result.provider };
      },
    };
  });
  settings = await import('../src/settings.js');
  const catalog = await import('../src/provider/catalog.js');
  catalog.writeCatalogSnapshot(
    {
      fixture: {
        npm: '@ai-sdk/gateway',
        models: { modelx: { tool_call: true, limit: { context: 100_000 } }, minimax: { tool_call: true, limit: { context: 100_000 } } },
      },
    },
    new Date().toISOString(),
  );
  const store = settings.defaultSettings();
  store.providers.fixture = {
    enabled: true,
    keys: ['fixture-a'],
    models: ['modelx', 'minimax'],
    modelRouting: { modelx: { only: ['deepinfra'] } },
  };
  store.defaultProvider = 'fixture';
  store.defaultModel = 'modelx';
  settings.saveSettings(store);
  runtime = await (await import('../src/agent-runtime.js')).createAgentRuntime({ workspaceRoot: directory });
});
afterEach(async () => {
  await runtime?.close();
  vi.unstubAllEnvs();
});

describe('live runtime settings', () => {
  it('restores an old session model without rewriting the global default or waiting for a stale catalog refresh', async () => {
    const catalog = await import('../src/provider/catalog.js');
    catalog.writeCatalogSnapshot(
      {
        fixture: {
          npm: '@ai-sdk/gateway',
          models: {
            modelx: { limit: { context: 100_000 } },
            minimax: { limit: { context: 100_000 } },
          },
        },
      },
      new Date(0).toISOString(),
    );
    const savedFetch = globalThis.fetch;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    globalThis.fetch = fetcher;
    try {
      await runtime.restoreModel!('fixture', 'minimax');
      expect(runtime.modelId).toBe('minimax');
      expect(settings.loadSettings().defaultModel).toBe('modelx');
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('borrows one daemon MCP manager across chat runtimes and refreshes each catalogue by revision', async () => {
    let revision = 0;
    const shared: import('../src/tools/mcp.js').McpConnectionManager = {
      get revision() {
        return revision;
      },
      tools: [],
      list: () => [],
      addServer: vi.fn(),
      connectServer: vi.fn(),
      disconnectServer: vi.fn(),
      removeServer: vi.fn(),
      reload: vi.fn(async () => false),
      close: vi.fn(async () => {}),
    };
    const { createAgentRuntime } = await import('../src/agent-runtime.js');
    const a = await createAgentRuntime({ workspaceRoot: directory, mcpManager: shared });
    const b = await createAgentRuntime({ workspaceRoot: directory, mcpManager: shared });
    let aClosed = false;
    try {
      expect(calls.connectMcp).toHaveBeenCalledOnce();
      await Promise.all([a.prepareForTurn!(), b.prepareForTurn!()]);
      const firstRegistry = b.registry;
      revision++;
      await b.reloadSettings!();
      expect(b.registry).not.toBe(firstRegistry);
      await a.close();
      aClosed = true;
      expect(shared.close).not.toHaveBeenCalled();
      await b.reloadSettings!(true);
    } finally {
      if (!aClosed) await a.close();
      await b.close();
      expect(shared.close).not.toHaveBeenCalled();
      await shared.close();
    }
  });

  it('opens an interactive chat before MCP connects and waits for its tools before the first model request', async () => {
    const store = settings.loadSettings();
    store.mcpServers.slow = { transport: 'stdio', command: 'fixture-mcp', args: [], env: {} };
    settings.saveSettings(store);
    const deferred = await (await import('../src/agent-runtime.js')).createAgentRuntime({ workspaceRoot: directory, deferMcp: true });
    const { AgentSessionController } = await import('../src/agent-session.js');
    const controller = new AgentSessionController(deferred);
    let release!: (changed: boolean) => void;
    const connected = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    calls.reloadMcp.mockImplementationOnce(() => connected);
    const stream = vi.fn(async () => response('stop'));
    (deferred.model as MockLanguageModelV3).doStream = stream;
    try {
      expect(calls.connectMcp).toHaveBeenLastCalledWith({});
      expect(controller.getSnapshot().session.id).toBeTruthy();
      expect(controller.getSnapshot().session.entries).toEqual([]);
      await deferred.reloadSettings!(true);
      expect(calls.reloadMcp).not.toHaveBeenCalled();
      const turn = controller.sendMessage({ text: 'First message', images: [] });
      await vi.waitFor(() => expect(calls.reloadMcp).toHaveBeenCalledWith(settings.loadSettings().mcpServers));
      expect(stream).not.toHaveBeenCalled();
      release(true);
      await turn;
      expect(stream).toHaveBeenCalledOnce();
      await deferred.prepareForTurn!();
      expect(calls.reloadMcp).toHaveBeenCalledOnce();
    } finally {
      release(true);
      await controller.close();
      await deferred.close();
    }
  });

  it('refreshes custom-model capabilities after an external catalog update without changing settings or restarting', async () => {
    const latest = settings.loadSettings();
    latest.providers.custom = {
      enabled: true,
      npm: '@ai-sdk/openai-compatible',
      url: 'http://localhost:1234/v1',
      keys: ['fixture-custom'],
      models: ['new-custom-model'],
      modelSpecs: { 'new-custom-model': { context: 100_000 } },
    };
    settings.saveSettings(latest);
    await runtime.selectModel('custom', 'new-custom-model');
    expect(runtime.contextWindowTokens).toBe(100_000);
    expect(runtime.reasoningVariants.map((variant) => variant.id)).toEqual(['default']);

    const catalog = await import('../src/provider/catalog.js');
    catalog.writeCatalogSnapshot(
      {
        mirror: {
          npm: '@ai-sdk/openai-compatible',
          models: {
            'new-custom-model': {
              reasoning: true,
              reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
              limit: { context: 1048576, output: 32768 },
            },
          },
        },
      },
      new Date().toISOString(),
    );
    const saved = settings.loadSettings();
    await runtime.reloadSettings!();
    // Capabilities refresh with the catalog, but the explicit settings window
    // survives it: an owner-set context wins over the catalog value.
    expect(runtime.contextWindowTokens).toBe(100_000);
    expect(runtime.outputLimitTokens).toBe(32768);
    expect(runtime.reasoningVariants.map((variant) => variant.id)).toEqual(['default', 'low', 'high']);
    expect(runtime.reasoningMetadataSource).toBe('mirror');
    expect(settings.loadSettings()).toEqual(saved);
    await runtime.reloadSettings!();
    expect(calls.build).toHaveBeenCalledTimes(3);
  });

  it('lets an explicit modelSpecs context win over the catalog window in both directions', async () => {
    const overridden = settings.loadSettings();
    overridden.providers.fixture!.modelSpecs = { modelx: { context: 500_000 } };
    settings.saveSettings(overridden);
    await runtime.reloadSettings!();
    // The catalog still reports 100000 for this model; the explicit value wins.
    expect(runtime.contextWindowTokens).toBe(500_000);

    await runtime.selectModel('fixture', 'minimax');
    // No explicit window for this model, so the catalog limit applies again.
    expect(runtime.contextWindowTokens).toBe(100_000);
  });

  it('resolves window and output from the same authority at every call site', async () => {
    const catalog = await import('../src/provider/catalog.js');
    catalog.writeCatalogSnapshot(
      {
        fixture: {
          npm: '@ai-sdk/gateway',
          models: {
            modelx: { tool_call: true, limit: { context: 100_000, output: 32_768 } },
            minimax: { tool_call: true, limit: { context: 100_000, output: 32_768 } },
          },
        },
      },
      new Date().toISOString(),
    );
    // Settings names only the window: output still falls back to the catalog
    // instead of reversing the priority (the 2026-11-03 divergence bug).
    const windowOnly = settings.loadSettings();
    windowOnly.providers.fixture!.modelSpecs = { modelx: { context: 500_000 } };
    settings.saveSettings(windowOnly);
    await runtime.reloadSettings!();
    expect(runtime.contextWindowTokens).toBe(500_000);
    expect(runtime.outputLimitTokens).toBe(32_768);

    // Settings names both: both win, on creation and across a model switch.
    const both = settings.loadSettings();
    both.providers.fixture!.modelSpecs = { modelx: { context: 500_000, output: 4_096 } };
    settings.saveSettings(both);
    await runtime.reloadSettings!();
    expect(runtime.contextWindowTokens).toBe(500_000);
    expect(runtime.outputLimitTokens).toBe(4_096);
    await runtime.selectModel('fixture', 'minimax');
    expect(runtime.contextWindowTokens).toBe(100_000);
    expect(runtime.outputLimitTokens).toBe(32_768);
  });

  it('restores another chat model without changing defaults or the first runtime', async () => {
    const other = await (
      await import('../src/agent-runtime.js')
    ).createAgentRuntime({ workspaceRoot: directory, initialModel: { providerId: 'fixture', modelId: 'minimax' } });
    try {
      expect(other.modelId).toBe('minimax');
      expect(runtime.modelId).toBe('modelx');
      expect(settings.loadSettings().defaultModel).toBe('modelx');
      await other.selectModel('fixture', 'minimax');
      await runtime.reloadSettings!();
      expect(other.modelId).toBe('minimax');
      expect(runtime.modelId).toBe('modelx');
    } finally {
      await other.close();
    }
  });
  it('refreshes keys and model routing without changing the selected model or rewriting files', async () => {
    const originalModel = runtime.model;
    const latest = settings.loadSettings();
    latest.providers.fixture!.keys = ['fixture-b'];
    latest.providers.fixture!.modelRouting = { modelx: { only: ['parasail'] } };
    latest.defaultModel = 'minimax';
    settings.saveSettings(latest);
    await runtime.reloadSettings!();
    expect(runtime.model).not.toBe(originalModel);
    expect(runtime.modelId).toBe('modelx');
    expect(calls.build.mock.lastCall?.[2].keys).toEqual(['fixture-b']);
    expect(runtime.getReasoningProviderOptions('default', false)).toEqual({ gateway: { only: ['parasail'] } });
    await runtime.reloadSettings!();
    expect(calls.build).toHaveBeenCalledTimes(2);
    expect(settings.loadSettings().defaultModel).toBe('minimax');
  });

  it('carries this conversation session id on a gateway provider, live and in every model state', async () => {
    // The runtime's own model: the member reads the resolved provider live, so a
    // model switch changes what it names without a new object.
    expect(runtime.sessionAffinityProviderOptions?.('sess-1')).toEqual({ gateway: { sessionId: 'sess-1' } });
    // Both ways a chat obtains a state: the runtime's own pair and another pair.
    const own = await runtime.modelFor!('fixture', 'modelx');
    expect(own.sessionAffinityProviderOptions?.('sess-1')).toEqual({ gateway: { sessionId: 'sess-1' } });
    const other = await runtime.modelFor!('fixture', 'minimax');
    expect(other.sessionAffinityProviderOptions?.('sess-1')).toEqual({ gateway: { sessionId: 'sess-1' } });
  });

  it('updates reviewer selection and preferences and can return to the main reviewer model', async () => {
    const latest = settings.loadSettings();
    latest.autoReviewProvider = 'fixture';
    latest.autoReviewModel = 'minimax';
    latest.showReasoning = false;
    latest.approvalMode = 'auto-review';
    settings.saveSettings(latest);
    await runtime.reloadSettings!();
    expect((runtime.reviewModel as MockLanguageModelV3).modelId).toBe('minimax');
    expect(runtime.showReasoningDefault).toBe(false);
    expect(runtime.approvalMode).toBe('auto-review');
    delete latest.autoReviewProvider;
    delete latest.autoReviewModel;
    settings.saveSettings(latest);
    await runtime.reloadSettings!();
    expect(runtime.reviewModel).toBeUndefined();
  });

  it('defers MCP reloads until the host explicitly allows tool changes', async () => {
    await runtime.reloadSettings!();
    expect(calls.reloadMcp).not.toHaveBeenCalled();
    await runtime.reloadSettings!(true);
    expect(calls.reloadMcp).toHaveBeenCalledWith({});
  });

  it('rejects invalid edits and removed credentials, then recovers on the next valid edit', async () => {
    const latest = settings.loadSettings();
    const originalModel = runtime.model;
    const lastValidSettings = readFileSync(settings.getSettingsPath(), 'utf8');
    writeFileSync(settings.getSettingsPath(), 'providers: [');
    await expect(runtime.reloadSettings!()).rejects.toThrow();
    expect(runtime.model).toBe(originalModel);
    // Restore the last valid on-disk file before saving a new revision.
    // Stale settings snapshots must not silently overwrite external edits.
    writeFileSync(settings.getSettingsPath(), lastValidSettings);
    latest.providers.fixture!.enabled = false;
    settings.saveSettings(latest);
    await expect(runtime.reloadSettings!()).rejects.toThrow(/disabled or not configured/);
    latest.providers.fixture!.enabled = true;
    latest.providers.fixture!.keys = ['fixture-c'];
    settings.saveSettings(latest);
    await runtime.reloadSettings!();
    expect(calls.build.mock.lastCall?.[2].keys).toEqual(['fixture-c']);
  });

  it('uses a changed credential on the next SDK step of the same running turn', async () => {
    (runtime.model as MockLanguageModelV3).doStream = async () => response('tool-calls');
    const { runAgent } = await import('../src/agent.js');
    await runAgent({
      model: runtime.model,
      system: 'Fixture',
      messages: [{ role: 'user', content: 'Refresh' }],
      getModel: async () => {
        await runtime.reloadSettings!();
        return runtime.model;
      },
      tools: {
        changeSettings: tool({
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute: async () => {
            const latest = settings.loadSettings();
            latest.providers.fixture!.keys = ['fixture-next-step'];
            settings.saveSettings(latest);
            return 'updated';
          },
        }),
      },
    });
    expect(calls.build).toHaveBeenCalledTimes(2);
    expect(calls.build.mock.lastCall?.[2].keys).toEqual(['fixture-next-step']);
  });

  it('uses changed approval policy for later calls in an already-created tool set', async () => {
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => 'ok');
    const approve = vi.fn(async () => true);
    registry.register({
      providerId: 'host',
      name: 'change',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'modify', data: 'local', network: 'none', reversible: 'full', outbound: 'none' },
      execute,
    });
    let mode: import('../src/settings.js').ApprovalMode = 'full-access';
    const built = await registry.createModelTools({ approve, approvalMode: () => mode, onResult: () => {} });
    await built.tools.change!.execute!({}, { toolCallId: 'first', messages: [] });
    expect(approve).not.toHaveBeenCalled();
    mode = 'workspace';
    await built.tools.change!.execute!({}, { toolCallId: 'second', messages: [] });
    expect(approve).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('a chat owns its model', () => {
  it('keeps the shared runtime on its own model while one chat picks another', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const first = new AgentSessionController(runtime);
    const second = new AgentSessionController(runtime);
    try {
      expect(first.getSnapshot().session.modelId).toBe('modelx');
      expect(second.getSnapshot().session.modelId).toBe('modelx');

      // One chat picks a different model.
      await first.selectModel('fixture', 'minimax');

      // That chat runs with the model it picked...
      expect(first.getSnapshot().session.modelId).toBe('minimax');
      // ...and the other chat keeps the model it had.
      expect(second.getSnapshot().session.modelId).toBe('modelx');
      // The shared runtime never moved: a chat asks for the state of the
      // model it wants, it does not rebind the runtime that every other
      // chat in the workspace shares.
      expect(runtime.modelId).toBe('modelx');
      expect(runtime.providerId).toBe('fixture');
      // The machine default is untouched too.
      expect(settings.loadSettings().defaultModel).toBe('modelx');
    } finally {
      await first.close();
      await second.close();
    }
  });
});
