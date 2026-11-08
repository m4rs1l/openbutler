import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/memory-index.js', () => ({
  MemoryIndex: class {
    async close() {}
  },
  isMemoryEmbeddingModelPrepared: async () => true,
}));
// The shared catalogue is exercised on its own in tests/tools/catalog.test.ts.
// Here it is empty, so every name the registry carries is one the runtime
// registered itself and a passing assertion cannot come from the catalogue.
vi.mock('../src/tools/catalog.js', () => ({ createToolCatalogue: () => [] }));
vi.mock('../src/tools/mcp.js', () => ({
  connectMcpServers: async () => ({ tools: [], list: () => [], close: async () => {}, reload: async () => false }),
}));

let directory: string;
let runtime: import('../src/agent-session.js').AgentEnvironment;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'openbutler-team-tools-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', directory);
  vi.resetModules();
  vi.doMock('../src/provider/registry.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/provider/registry.js')>();
    return {
      ...actual,
      createLanguageModel: async (id: string, modelId: string, state: import('../src/settings.js').ProviderState) => {
        const result = actual.resolveProvider(id, state);
        if (!result.ok) return result;
        return {
          ok: true,
          model: new MockLanguageModelV3({
            modelId,
            doStream: async () => {
              throw new Error('No turn runs in this test.');
            },
          }),
          resolved: result.provider,
        };
      },
    };
  });
  const settings = await import('../src/settings.js');
  const catalog = await import('../src/provider/catalog.js');
  catalog.writeCatalogSnapshot(
    { fixture: { npm: '@ai-sdk/gateway', models: { modelx: { tool_call: true, limit: { context: 100_000 } } } } },
    new Date().toISOString(),
  );
  const store = settings.defaultSettings();
  store.providers.fixture = { enabled: true, keys: ['fixture-a'], models: ['modelx'] };
  store.defaultProvider = 'fixture';
  store.defaultModel = 'modelx';
  settings.saveSettings(store);
  runtime = await (await import('../src/agent-runtime.js')).createAgentRuntime({ workspaceRoot: directory });
});

afterEach(async () => {
  await runtime?.close();
  vi.unstubAllEnvs();
});

describe('team surface registration', () => {
  it('gives a runtime that was handed no team handler no team tool', () => {
    const names = runtime.registry.names();
    for (const team of ['team_delivery', 'team_send', 'team_status', 'team_work', 'team_profile']) expect(names).not.toContain(team);
    // A worker's toolkit is its parent's registry narrowed to the grant, so a
    // chat that holds no team tool cannot hand one down to a worker either.
    expect(runtime.registry.subset(['team_send', 'team_status']).names()).toEqual([]);
  });

  it('registers only the team tools whose handlers it was given', async () => {
    const { createAgentRuntime } = await import('../src/agent-runtime.js');
    const custodian = await createAgentRuntime({
      workspaceRoot: directory,
      teamSend: async () => ({ status: 'ok' }),
      teamStatus: async () => ({ members: [] }),
    });
    try {
      const names = custodian.registry.names();
      expect(names).toContain('team_send');
      expect(names).toContain('team_status');
      expect(names).not.toContain('team_work');
      expect(custodian.registry.subset(['team_send']).names()).toEqual(['team_send']);
    } finally {
      await custodian.close();
    }
  });
});
