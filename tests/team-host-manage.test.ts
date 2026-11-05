import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonHost } from '../src/daemon-host.js';
import { ToolRegistry } from '../src/tools/registry.js';

let root: string;
let host: DaemonHost;
let server: Server;
let requestHost: (typeof import('../src/daemon.js'))['requestHost'];

async function createFixtureHost(): Promise<DaemonHost> {
  const { createDaemonHost } = await import('../src/daemon-host.js');
  const registry = new ToolRegistry();
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  return createDaemonHost({
    startedAt: new Date().toISOString(),
    requestStop: () => {},
    log: () => {},
    runtimeFactory: async (options) => ({
      model,
      workspaceRoot: options?.workspaceRoot ?? process.cwd(),
      modelName: 'Local fixture',
      providerId: 'fixture',
      modelId: 'fixture',
      contextWindowTokens: null,
      outputLimitTokens: null,
      supportsVision: false,
      supportsImageToolResult: true,
      reasoningVariants: [],
      reasoningMetadataSource: null,
      reasoningSupport: 'model-unsupported',
      reasoningDefault: 'default',
      showReasoningDefault: false,
      saveReasoningPreference: () => {},
      saveShowReasoningPreference: () => {},
      getReasoningProviderOptions: () => ({}),
      getReviewProviderOptions: () => ({}),
      registry,
      selectModel: async () => {},
      close: async () => {},
    }),
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-team-host-'));
  mkdirSync(join(root, 'custodian'), { recursive: true });
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();
  const daemon = await import('../src/daemon.js');
  requestHost = daemon.requestHost;
  host = await createFixtureHost();
  server = createServer((socket) => host.handleConnection(socket));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(daemon.getDaemonEndpoint(), () => resolveListen());
  });
  await host.start();
});

afterEach(async () => {
  await host.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-team-host-')) {
    throw new Error('Unsafe fixture cleanup path.');
  }
  rmSync(root, { recursive: true, force: true });
});

describe('team.manage host ownership', () => {
  it('initializes the hub store and settings without a CLI TeamStore', async () => {
    const result = (await requestHost('team.manage', {
      input: { action: 'init', as: 'Atreus-OpenButler', name: 'MyTeam', port: 47821, hubHost: '100.64.0.1' },
    })) as { teamName: string; memberName: string; hubHost: string };
    expect(result).toMatchObject({ teamName: 'MyTeam', memberName: 'Atreus-OpenButler', hubHost: '100.64.0.1' });
    const settings = await import('../src/settings.js');
    expect(settings.loadSettings().team).toMatchObject({
      role: 'hub',
      teamName: 'MyTeam',
      memberName: 'Atreus-OpenButler',
      hubHost: '100.64.0.1',
    });
    const { TeamStore } = await import('../src/team/store.js');
    const store = new TeamStore(join(root, 'team.db'));
    try {
      expect(store.isInitialized()).toBe(true);
      expect(store.getMeta('team_name')).toBe('MyTeam');
    } finally {
      store.close();
    }
  });

  it('writes invites through the host store', async () => {
    await requestHost('team.manage', {
      input: { action: 'init', as: 'Atreus-OpenButler', name: 'MyTeam', hubHost: '100.64.0.1' },
    });
    const invite = (await requestHost('team.manage', { input: { action: 'invite', ttlMinutes: 10 } })) as {
      code: string;
      fingerprint: string;
    };
    expect(invite.code).toBeTruthy();
    expect(invite.fingerprint).toMatch(/^[A-F0-9:]+$/);
    const listed = (await requestHost('team.manage', { input: { action: 'invites' } })) as { invites: Array<{ code: string }> };
    expect(listed.invites.map((row) => row.code)).toEqual([invite.code]);
  });

  it('refuses hub-only actions on a machine that is not a hub', async () => {
    await expect(requestHost('team.manage', { input: { action: 'invite', ttlMinutes: 10 } })).rejects.toThrow('Only the hub');
  });
});
