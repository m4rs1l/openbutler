import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeViewData, SessionSnapshotData } from '../src/daemon-protocol.js';
import type { WebServer } from '../src/web/server.js';

/**
 * The endpoint the web draft chat asks before it offers effort levels. The picker
 * only stays honest if this answers from the model id and refuses anything the
 * settings do not actually configure.
 */
let root: string;
let ipc: Server;
let socket: Socket | undefined;
let web: WebServer | undefined;
let cookie: string;
/** The levels this chat's own model offers; the runtime fixture below holds none. */
const sessionVariants = [{ id: 'low', label: 'Low' }];

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
      reasoningVariants: sessionVariants,
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
    reasoningVariants: [],
    reasoningMetadataSource: null,
    reasoningSupport: 'model-unsupported',
    reasoningDefault: 'default',
    showReasoningDefault: true,
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-model-reasoning-'));
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
  store.providers['disabled-p'] = { enabled: false, keys: ['disabled-key'], npm: '@ai-sdk/gateway', models: ['modelx'] };
  settings.saveSettings(store);

  // The web server always attaches to a session client, so the fixture answers
  // every daemon request with an empty chat.
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
  await new Promise<void>((done, fail) => {
    ipc.once('error', fail);
    ipc.listen(getDaemonEndpoint(), done);
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
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-model-reasoning-')) {
    throw new Error('Unsafe model-reasoning fixture cleanup path.');
  }
  rmSync(root, { recursive: true, force: true });
});

async function ask(query: string): Promise<{
  status: number;
  body: { reasoningVariants?: Array<{ id: string; label: string }>; reasoningDefault?: string; error?: string };
}> {
  const response = await fetch(`${web!.url}/api/models/reasoning?${query}`, { headers: { cookie } });
  return { status: response.status, body: (await response.json()) as never };
}

it('answers with the efforts the chosen model offers', async () => {
  const { status, body } = await ask('providerId=fixture&modelId=modelx');
  expect(status).toBe(200);
  expect(body.reasoningVariants!.map((variant) => variant.id)).toEqual(['default', 'low', 'high']);
  // The picker renders the label and posts the id back, so both must be present.
  expect(body.reasoningVariants!.every((variant) => typeof variant.label === 'string' && variant.label.length > 0)).toBe(true);
  expect(body.reasoningVariants!.map((variant) => variant.id)).toContain(body.reasoningDefault!);
});

it('accepts an effort the session offers while the shared runtime holds another list', async () => {
  // The runtime fixture offers nothing; this chat's recorded model offers 'low'.
  // The shared list must not refuse what the picker showed for this session.
  const post = (reasoningVariantId: string) =>
    fetch(`${web!.url}/api/reasoning`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reasoningVariantId, sessionId: 'chat' }),
    });

  const accepted = await post('low');
  expect(accepted.status).toBe(200);

  const refused = await post('high');
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: string }).error).toBe('Choose a supported effort level.');
});

it('refuses a provider or model the settings do not offer', async () => {
  const refused = [
    'providerId=nope&modelId=modelx',
    'providerId=fixture&modelId=modelz',
    'providerId=disabled-p&modelId=modelx',
    'providerId=fixture',
    'modelId=modelx',
  ];
  for (const query of refused) {
    const { status, body } = await ask(query);
    expect(status, query).toBe(400);
    expect(typeof body.error).toBe('string');
  }
});
