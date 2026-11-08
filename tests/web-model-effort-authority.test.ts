import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeViewData, SessionSnapshotData } from '../src/daemon-protocol.js';
import type { WebServer } from '../src/web/server.js';

/**
 * The endpoint the picker asks before it offers effort levels.
 *
 * It must answer from the CHAT that is asking, not from the machine default
 * in settings.yaml. Two authorities answering the same question is what makes
 * a chat's effort look like it changes by itself: the picker shows one value
 * and the next request runs with another.
 */

let root: string;
let ipc: Server;
let socket: Socket | undefined;
let web: WebServer | undefined;
let cookie: string;
/** The levels this chat's model offers. */
const modelLevels = ['default', 'low', 'high'];

function snapshot(): SessionSnapshotData {
  const now = new Date().toISOString();
  return {
    session: {
      version: 1,
      id: 'chat',
      title: 'Chat',
      providerId: 'fixture',
      modelId: 'modelx',
      createdAt: now,
      updatedAt: now,
      entries: [],
      // This chat chose "low" for itself.
      reasoning: 'low',
      reasoningVariants: modelLevels.map((id) => ({ id, label: id })),
    },
    busy: false,
    runningTurnId: null,
    pendingApproval: null,
    pendingApprovalId: null,
    pendingQuestion: null,
    queuedMessageCount: 0,
    firstQueuedMessage: null,
    queuedMessages: [],
    sessionSaveError: null,
    streamingAssistantIndex: null,
  };
}

function runtime(): RuntimeViewData {
  return {
    workspaceRoot: root,
    modelName: 'Fixture',
    providerId: 'fixture',
    modelId: 'modelx',
    contextWindowTokens: null,
    supportsVision: false,
    reasoningVariants: modelLevels.map((id) => ({ id, label: id, providerOptions: {} })),
    reasoningMetadataSource: null,
    reasoningSupport: 'available',
    reasoningDefault: 'low',
    showReasoningDefault: true,
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-model-effort-web-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();

  const catalog = await import('../src/provider/catalog.js');
  catalog.writeCatalogSnapshot(
    {
      'gateway-fixture': {
        npm: '@ai-sdk/gateway',
        models: {
          modelx: {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
            limit: { context: 100_000 },
          },
        },
      },
    },
    new Date().toISOString(),
  );
  const settings = await import('../src/settings.js');
  const store = settings.defaultSettings();
  store.providers.fixture = { enabled: true, keys: ['fixture-key'], npm: '@ai-sdk/gateway', models: ['modelx'] };
  // The machine default says "high"; this chat chose "low" for itself.
  store.reasoning = 'high';
  settings.saveSettings(store);

  ipc = createServer((connection) => {
    socket = connection;
    let buffer = '';
    connection.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)) as { id: string };
        buffer = buffer.slice(newline + 1);
        connection.write(
          JSON.stringify({
            version: 2,
            id: request.id,
            ok: true,
            result: {
              snapshot: snapshot(),
              runtime: runtime(),
              savedSessions: [],
              clientKind: 'web',
              sessionAttachments: true,
              workspaceKey: root,
            },
          }) + '\n',
        );
      }
    });
  });
  const { getDaemonEndpoint } = await import('../src/daemon.js');
  await new Promise((done, fail) => {
    ipc.once('error', fail);
    ipc.listen(getDaemonEndpoint(), () => done(undefined));
  });

  const { startWebServer } = await import('../src/web/server.js');
  web = await startWebServer({ workspaceRoot: root, port: 0, assetsDir: join(root, 'no-assets') });
  const paired = await fetch(web.pairUrl, { redirect: 'manual' });
  cookie = paired.headers.get('set-cookie')!.split(';')[0]!;
});

afterEach(async () => {
  await web?.close();
  web = undefined;
  socket?.destroy();
  await new Promise<void>((done) => ipc.close(() => done()));
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-model-effort-web-')) {
    throw new Error('Unsafe model-effort web fixture cleanup path.');
  }
  rmSync(root, { recursive: true, force: true });
});

it('answers with the effort this chat chose, not with the machine default', async () => {
  const response = await fetch(`${web!.url}/api/models/reasoning?providerId=fixture&modelId=modelx`, {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { reasoningVariants: Array<{ id: string }>; reasoningDefault: string };
  expect(body.reasoningVariants.map((variant) => variant.id)).toEqual(modelLevels);
  // The chat chose "low"; the machine default says "high". The picker must
  // show what this chat will actually run with.
  expect(body.reasoningDefault).toBe('low');
});

it('sends the same answer the runtime view reports', async () => {
  const [reasoning, snapshotResponse] = await Promise.all([
    fetch(`${web!.url}/api/models/reasoning?providerId=fixture&modelId=modelx`, { headers: { cookie } }),
    fetch(`${web!.url}/api/snapshot`, { headers: { cookie } }),
  ]);
  const described = (await reasoning.json()) as { reasoningDefault: string };
  const view = (await snapshotResponse.json()) as { runtime: { reasoningDefault: string } };
  expect(described.reasoningDefault).toBe(view.runtime.reasoningDefault);
});
