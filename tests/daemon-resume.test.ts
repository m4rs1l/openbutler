import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonHost } from '../src/daemon-host.js';
import type { DaemonSessionConnection } from '../src/daemon-client.js';

import type { SessionSummary } from '../src/session-store.js';
import { DaemonFrameDecoder } from '../src/daemon-frames.js';
import { DAEMON_PROTOCOL_VERSION, MAX_DAEMON_FRAME_BYTES } from '../src/daemon-protocol.js';

/**
 * Phase 4: which chat a surface opens, and which backend a web server dials.
 *
 * The client used to know from its own disk which chat to resume, which is
 * wrong the moment the chats live on another machine. The host owns the list,
 * so the client asks it - the same list-then-open a browser API does - and it
 * asks BEFORE attaching, because attaching already requires naming the chat.
 * These tests pin that pre-attach list, the wire-resume contract, and the
 * `web --backend <name>` selection flag.
 */

let root: string;
let hosts: DaemonHost[] = [];
let servers: Server[] = [];
let clients: DaemonSessionConnection[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-resume-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();
  hosts = [];
  servers = [];
  clients = [];
  // A host start builds the custodian runtime, which needs a configured default
  // provider plus an offline catalog snapshot before any server can come up.
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
});

afterEach(async () => {
  for (const client of clients) await client.close();
  for (const host of hosts) await host.close();
  await Promise.all(servers.map((server) => new Promise<void>((done) => (server.listening ? server.close(() => done()) : done()))));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-resume-'))
    throw new Error('Unsafe fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

async function makeHost(): Promise<DaemonHost> {
  const { createDaemonHost } = await import('../src/daemon-host.js');
  const host = await createDaemonHost({ startedAt: new Date().toISOString(), requestStop: () => {}, log: () => {} });
  hosts.push(host);
  return host;
}

/** The local pipe listener every install has, where the OS owns access. */
async function listenPipeFor(host: DaemonHost): Promise<void> {
  const daemon = await import('../src/daemon.js');
  const server = createServer((socket) => host.handleConnection(socket));
  servers.push(server);
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(daemon.getDaemonEndpoint(), () => res());
  });
}

/** A TCP listener exactly as `--listen` binds it: the remote auth gate applies. */
async function listenRemoteFor(host: DaemonHost): Promise<number> {
  const server = createServer((socket) => host.handleConnection(socket, { remote: true }));
  servers.push(server);
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Listener has no port.');
  return address.port;
}

async function waitFor(probe: () => unknown, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await probe();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

/** A raw protocol client: send frames by hand, read every frame the host returns. */
async function openRaw(target: number | string): Promise<{
  socket: Socket;
  frames: string[];
  send: (frame: unknown) => void;
  untilClosed: Promise<void>;
}> {
  // number = TCP port (remote listener), string = named-pipe endpoint (local host).
  const socket = typeof target === 'number' ? createConnection(target, '127.0.0.1') : createConnection(target);
  const frames: string[] = [];
  const decoder = new DaemonFrameDecoder(MAX_DAEMON_FRAME_BYTES);
  const untilClosed = new Promise<void>((done) => socket.once('close', () => done()));
  socket.on('data', (chunk) => {
    try {
      for (const frame of decoder.append(chunk)) frames.push(frame.toString('utf8'));
    } catch {
      // The host's own frame limit; this client never sends one.
    }
  });
  socket.on('error', () => {});
  await new Promise<void>((res, rej) => {
    socket.once('connect', () => res());
    socket.once('error', rej);
  });
  return {
    socket,
    frames,
    send: (frame: unknown) => void socket.write(`${JSON.stringify(frame)}\n`),
    untilClosed,
  };
}

const parsed = (raw: string) => JSON.parse(raw) as Record<string, unknown>;
const listFrame = (id = 'list-1') => ({ version: DAEMON_PROTOCOL_VERSION, id, action: 'session.list' });
const authFrame = (token: string) => ({ version: DAEMON_PROTOCOL_VERSION, id: 'auth-1', action: 'auth', token });

/** A real saved chat in this mocked data directory, so the host has a list to answer with. */
async function saveChat(title: string): Promise<SessionSummary> {
  const store = await import('../src/session-store.js');
  // Machine-wide chat sessions carry no workspaceRoot, which is exactly the scope
  // `listSavedSessions(null)` answers with and `resumeChatAttach` always read.
  const base = store.createSession('fixture', 'modelx');
  const saved = store.saveSession({
    ...base,
    title,
    entries: [
      { kind: 'user', text: `hello ${title}` },
      { kind: 'assistant', text: 'reply' },
    ],
    conversation: [{ role: 'user', content: `hello ${title}` }],
  });
  const listed = store.listSavedSessions(null).find((entry) => entry.id === saved.id);
  // The fixture must be visible to the very listing the code under test reads.
  expect(listed).toBeDefined();
  return listed!;
}

describe('the host answers session.list before any attachment', () => {
  it('answers on the local pipe without an attachment or a workspace key', async () => {
    const chat = await saveChat('Pipe pre-attach');
    const host = await makeHost();
    await listenPipeFor(host);
    await host.start();
    const endpoint = (await import('../src/daemon.js')).getDaemonEndpoint();
    const socket = createConnection(endpoint);
    const frames: string[] = [];
    const decoder = new DaemonFrameDecoder(MAX_DAEMON_FRAME_BYTES);
    socket.on('data', (chunk) => {
      for (const frame of decoder.append(chunk)) frames.push(frame.toString('utf8'));
    });
    socket.on('error', () => {});
    await new Promise<void>((res, rej) => {
      socket.once('connect', () => res());
      socket.once('error', rej);
    });
    socket.write(`${JSON.stringify(listFrame())}\n`);

    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    const response = parsed(frames[0]!);
    expect(response.id).toBe('list-1');
    expect(response.ok).toBe(true);
    expect((response.result as SessionSummary[]).map((entry) => entry.id)).toContain(chat.id);
    socket.destroy();
  });

  it('answers an authenticated remote socket before any attachment', async () => {
    const chat = await saveChat('Remote pre-attach');
    const { createAuthToken } = await import('../src/auth-tokens.js');
    const { token } = createAuthToken();
    const host = await makeHost();
    const port = await listenRemoteFor(host);
    await host.start();
    const raw = await openRaw(port);
    raw.send(authFrame(token));
    await waitFor(() => expect(raw.frames.length).toBeGreaterThan(0));
    expect(parsed(raw.frames[0]!).ok).toBe(true);

    raw.send(listFrame());
    await waitFor(() => expect(raw.frames.length).toBeGreaterThan(1));
    const response = parsed(raw.frames[1]!);
    expect(response.id).toBe('list-1');
    expect(response.ok).toBe(true);
    expect((response.result as SessionSummary[]).map((entry) => entry.id)).toContain(chat.id);
    raw.socket.destroy();
  });

  it('lists exactly what an attached client lists', async () => {
    await saveChat('Parity one');
    await saveChat('Parity two');
    const host = await makeHost();
    await listenPipeFor(host);
    await host.start();

    const raw = await openRaw((await import('../src/daemon.js')).getDaemonEndpoint());
    raw.send(listFrame());
    await waitFor(() => expect(raw.frames.length).toBeGreaterThan(0));
    const preAttach = parsed(raw.frames[0]!);
    expect(preAttach.ok).toBe(true);

    const { connectDaemonSession } = await import('../src/daemon-client.js');
    // A chat attach, the same attachment a resumed surface gets: chat controllers
    // list machine-wide (`sessionWorkspaceRoot: null`), which is the parity pair.
    const client = await connectDaemonSession(root, { clientKind: 'web', newChatSession: true });
    clients.push(client);
    const attached = await client.listSessions();

    expect((preAttach.result as SessionSummary[]).map((entry) => entry.id)).toEqual(attached.map((entry) => entry.id));
    raw.socket.destroy();
  });
});

describe('resume resolves over the wire, not from this machine', () => {
  it('resumeChatAttach carries only the instruction, never a chat read from the local store', async () => {
    await saveChat('Local store has this');
    const { resumeChatAttach } = await import('../src/daemon-client.js');
    expect(resumeChatAttach('terminal')).toEqual({ clientKind: 'terminal', resume: true });
  });

  it('picks the top of the host list when the host answers', async () => {
    const { resolveResumeAttach } = await import('../src/daemon-client.js');
    const result = await resolveResumeAttach({
      clientKind: 'web',
      askHost: async () => [idSummary('chat-from-host'), idSummary('older')],
      localList: () => [idSummary('local-should-not-be-used')],
    });
    expect(result.attach).toEqual({ clientKind: 'web', chatSessionId: 'chat-from-host' });
    expect(result.notice).toBeUndefined();
  });

  it('carries the attach options (the window) through to whichever chat it picks', async () => {
    const { resolveResumeAttach } = await import('../src/daemon-client.js');
    const result = await resolveResumeAttach({
      clientKind: 'web',
      base: { entriesWindow: 400 },
      askHost: async () => [idSummary('top')],
      localList: () => [],
    });
    expect(result.attach).toEqual({ entriesWindow: 400, clientKind: 'web', chatSessionId: 'top' });
    const fresh = await resolveResumeAttach({
      clientKind: 'web',
      base: { entriesWindow: 400 },
      askHost: async () => [],
      localList: () => [],
    });
    expect(fresh.attach).toEqual({ entriesWindow: 400, clientKind: 'web', newChatSession: true });
  });

  it('opens a new chat when the host list is empty', async () => {
    const { resolveResumeAttach } = await import('../src/daemon-client.js');
    const result = await resolveResumeAttach({ clientKind: 'terminal', askHost: async () => [], localList: () => [idSummary('local')] });
    expect(result.attach).toEqual({ clientKind: 'terminal', newChatSession: true });
    expect(result.notice).toBeUndefined();
  });

  it.each([['workspaceKey must be a non-empty string under 32768 bytes.'], ['This IPC client is not attached to that workspace.']])(
    'falls back to this machine%s when the host is an older build, with a visible notice',
    async (message) => {
      const { resolveResumeAttach } = await import('../src/daemon-client.js');
      const result = await resolveResumeAttach({
        clientKind: 'web',
        askHost: async () => {
          throw new Error(message);
        },
        localList: () => [idSummary('local-top')],
      });
      expect(result.attach).toEqual({ clientKind: 'web', chatSessionId: 'local-top' });
      expect(result.notice).toBeTruthy();
      expect(result.notice).toMatch(/older/i);
    },
  );

  it('propagates any other host error untouched', async () => {
    const { resolveResumeAttach } = await import('../src/daemon-client.js');
    await expect(
      resolveResumeAttach({
        clientKind: 'web',
        askHost: async () => {
          throw new Error('boom: the host is broken');
        },
        localList: () => [idSummary('local')],
      }),
    ).rejects.toThrow('boom: the host is broken');
  });

  it('refuses to combine resume with an explicitly named chat', async () => {
    const { connectDaemonSession } = await import('../src/daemon-client.js');
    await expect(connectDaemonSession(root, { clientKind: 'web', resume: true, chatSessionId: 'picked-anyway' })).rejects.toThrow(
      /must not also name a chat/,
    );
  });

  it('attaches to the saved chat through the actual resume path', async () => {
    const chat = await saveChat('Resume target');
    const host = await makeHost();
    await listenPipeFor(host);
    await host.start();
    const { connectDaemonSession, resumeChatAttach } = await import('../src/daemon-client.js');
    const client = await connectDaemonSession(root, resumeChatAttach('web'));
    clients.push(client);
    expect(client.getSnapshot().session.id).toBe(chat.id);
  });

  it('windows a resumed chat exactly like a direct web attach, so a long chat cannot outgrow a frame', async () => {
    const chat = await saveChat('Windowed resume');
    const host = await makeHost();
    await listenPipeFor(host);
    await host.start();
    const { connectDaemonSession, resumeChatAttach } = await import('../src/daemon-client.js');
    // The web server's startup attach (`web/server.ts`) is a resume with a
    // 400-entry window; the fixture holds two entries and a one-entry window
    // must survive the resume choice down to the host's snapshot.
    const client = await connectDaemonSession(root, { ...resumeChatAttach('web'), entriesWindow: 1 });
    clients.push(client);
    expect(client.getSnapshot().session.id).toBe(chat.id);
    expect(client.getSnapshot().session.entries).toHaveLength(1);
  });
});

function idSummary(id: string): SessionSummary {
  return { id, title: id, updatedAt: '2026-01-01T00:00:00.000Z' } as SessionSummary;
}

describe('openbutler web --backend selects the saved backend', () => {
  function writeRegistry(entry: Record<string, unknown>, active: string | null): void {
    writeFileSync(join(root, 'backends.json'), JSON.stringify({ active, backends: { zeus: entry } }));
  }

  it('activates the named backend and names its endpoint without the token', async () => {
    writeRegistry({ host: '100.64.0.5', port: 45278, token: 'obt_super-secret' }, null);
    const web = await import('../src/cli/web.js');
    const { parseArgs } = await import('../src/cli/args.js');
    const label = web.selectBackendFromFlag(parseArgs(['web', '--backend', 'zeus']));
    expect(label).toBe('zeus (100.64.0.5:45278)');
    expect(label).not.toContain('obt_');
    const { resolveActiveBackend } = await import('../src/backend-registry.js');
    expect(resolveActiveBackend()).toEqual({ host: '100.64.0.5', port: 45278, token: 'obt_super-secret' });
  });

  it('refuses an unknown backend name', async () => {
    writeRegistry({ host: '100.64.0.5', port: 45278 }, null);
    const web = await import('../src/cli/web.js');
    const { parseArgs } = await import('../src/cli/args.js');
    expect(() => web.selectBackendFromFlag(parseArgs(['web', '--backend', 'ghost']))).toThrow(/not saved/);
  });

  it('says the flag needs a name when given bare', async () => {
    const web = await import('../src/cli/web.js');
    const { parseArgs } = await import('../src/cli/args.js');
    expect(() => web.selectBackendFromFlag(parseArgs(['web', '--backend']))).toThrow(/--backend needs a saved name/);
  });

  it('leaves the saved selection alone when the flag is absent', async () => {
    writeRegistry({ host: '100.64.0.5', port: 45278 }, null);
    const web = await import('../src/cli/web.js');
    const { parseArgs } = await import('../src/cli/args.js');
    expect(web.selectBackendFromFlag(parseArgs(['web']))).toBeNull();
    const { resolveActiveBackend } = await import('../src/backend-registry.js');
    expect(resolveActiveBackend()).toBeNull();
  });
});
