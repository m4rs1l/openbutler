import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonHost } from '../src/daemon-host.js';
import type { DaemonSessionConnection } from '../src/daemon-client.js';
import { DaemonFrameDecoder } from '../src/daemon-frames.js';
import { DAEMON_PROTOCOL_VERSION, MAX_DAEMON_FRAME_BYTES } from '../src/daemon-protocol.js';

let root: string;
let hosts: DaemonHost[] = [];
let servers: Server[] = [];
let clients: DaemonSessionConnection[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-auth-'));
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
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-auth-'))
    throw new Error('Unsafe fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

async function makeHost(): Promise<DaemonHost> {
  const { createDaemonHost } = await import('../src/daemon-host.js');
  const host = await createDaemonHost({ startedAt: new Date().toISOString(), requestStop: () => {}, log: () => {} });
  hosts.push(host);
  return host;
}

/**
 * A TCP listener exactly as `--listen` binds it: every accepted socket is a
 * remote connection, so the auth gate applies to it.
 */
async function listenRemoteFor(host: DaemonHost, authTimeoutMs?: number): Promise<number> {
  const server = createServer((socket) => host.handleConnection(socket, { remote: true, authTimeoutMs }));
  servers.push(server);
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Listener has no port.');
  return address.port;
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
async function openRaw(port: number): Promise<{
  socket: Socket;
  frames: string[];
  send: (frame: unknown) => void;
  closed: () => boolean;
  untilClosed: Promise<void>;
}> {
  const socket = createConnection(port, '127.0.0.1');
  const frames: string[] = [];
  const decoder = new DaemonFrameDecoder(MAX_DAEMON_FRAME_BYTES);
  let isClosed = false;
  const untilClosed = new Promise<void>((done) => socket.once('close', () => ((isClosed = true), done())));
  socket.on('data', (chunk) => {
    try {
      for (const frame of decoder.append(chunk)) frames.push(frame.toString('utf8'));
    } catch {
      // An oversized frame is the host's own limit; this client never sends one.
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
    closed: () => isClosed,
    untilClosed,
  };
}

const statusFrame = { version: DAEMON_PROTOCOL_VERSION, id: 'status-1', action: 'status' };
const authFrame = (token: string) => ({ version: DAEMON_PROTOCOL_VERSION, id: 'auth-1', action: 'auth', token });
const parsed = (raw: string) => JSON.parse(raw) as Record<string, unknown>;

describe('auth token store', () => {
  it('stores only a salt and hash, never the plaintext token', async () => {
    const { createAuthToken, verifyAuthToken } = await import('../src/auth-tokens.js');
    const created = createAuthToken();
    expect(created.token).toMatch(/^obt_[A-Za-z0-9_-]{32}$/);
    expect(created.id).toBeTruthy();
    const raw = readFileSync(join(root, 'auth-tokens.json'), 'utf8');
    expect(raw).not.toContain(created.token);
    expect(raw).toContain(created.id);
    expect(verifyAuthToken(created.token)).toBe(true);
  });

  it('rejects a wrong token', async () => {
    const { createAuthToken, verifyAuthToken } = await import('../src/auth-tokens.js');
    createAuthToken();
    expect(verifyAuthToken('obt_not-the-token')).toBe(false);
    expect(verifyAuthToken('')).toBe(false);
  });

  it('fails closed when no token file exists', async () => {
    const { verifyAuthToken } = await import('../src/auth-tokens.js');
    expect(existsSync(join(root, 'auth-tokens.json'))).toBe(false);
    expect(verifyAuthToken('obt_anything')).toBe(false);
  });

  it('lists ids without exposing secrets', async () => {
    const { createAuthToken, listAuthTokens } = await import('../src/auth-tokens.js');
    const created = createAuthToken();
    const listed = listAuthTokens();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
    expect(JSON.stringify(listed)).not.toContain(created.token);
  });

  it('revokes a token so it no longer verifies', async () => {
    const { createAuthToken, revokeAuthToken, verifyAuthToken } = await import('../src/auth-tokens.js');
    const created = createAuthToken();
    expect(revokeAuthToken(created.id)).toBe(true);
    expect(verifyAuthToken(created.token)).toBe(false);
    expect(revokeAuthToken('missing-id')).toBe(false);
    expect(existsSync(join(root, 'auth-tokens.json'))).toBe(true);
  });
});

describe('remote authentication gate', () => {
  it('refuses a remote connection that sends a request before authenticating', async () => {
    const host = await makeHost();
    const port = await listenRemoteFor(host);
    await host.start();
    const raw = await openRaw(port);
    raw.send(statusFrame);
    await waitFor(() => expect(raw.frames.length).toBeGreaterThan(0));
    const response = parsed(raw.frames[0]!);
    expect(response.ok).toBe(false);
    expect(String(response.error)).toMatch(/authenticat/i);
    await raw.untilClosed;
    expect(raw.closed()).toBe(true);
  });

  it('refuses a remote connection presenting a wrong token', async () => {
    const { createAuthToken } = await import('../src/auth-tokens.js');
    createAuthToken();
    const host = await makeHost();
    const port = await listenRemoteFor(host);
    await host.start();
    const raw = await openRaw(port);
    raw.send(authFrame('obt_wrong-token-wrong-token-wrong'));
    await waitFor(() => expect(raw.frames.length).toBeGreaterThan(0));
    const response = parsed(raw.frames[0]!);
    expect(response.id).toBe('auth-1');
    expect(response.ok).toBe(false);
    expect(String(response.error)).toMatch(/authenticat/i);
    await raw.untilClosed;
    expect(raw.closed()).toBe(true);
  });

  it('admits a remote connection with a valid token and then serves requests', async () => {
    const { createAuthToken } = await import('../src/auth-tokens.js');
    const { token } = createAuthToken();
    const host = await makeHost();
    const port = await listenRemoteFor(host);
    await host.start();
    const raw = await openRaw(port);
    raw.send(authFrame(token));
    await waitFor(() => expect(raw.frames.length).toBeGreaterThan(0));
    const authResponse = parsed(raw.frames[0]!);
    expect(authResponse.id).toBe('auth-1');
    expect(authResponse.ok).toBe(true);
    expect(raw.closed()).toBe(false);
    raw.send(statusFrame);
    await waitFor(() => expect(raw.frames.length).toBeGreaterThan(1));
    const status = parsed(raw.frames[1]!);
    expect(status.id).toBe('status-1');
    expect(status.ok).toBe(true);
    raw.socket.destroy();
  });

  it('closes a remote connection that never authenticates', async () => {
    const host = await makeHost();
    const port = await listenRemoteFor(host, 150);
    await host.start();
    const raw = await openRaw(port);
    await raw.untilClosed;
    expect(raw.closed()).toBe(true);
    expect(raw.frames).toHaveLength(0);
  });

  it('refuses remote connections when the host has no tokens at all', async () => {
    const host = await makeHost();
    const port = await listenRemoteFor(host);
    await host.start();
    expect(existsSync(join(root, 'auth-tokens.json'))).toBe(false);
    const raw = await openRaw(port);
    raw.send(authFrame('obt_no-tokens-exist-no-tokens-exis'));
    await waitFor(() => expect(raw.frames.length).toBeGreaterThan(0));
    const response = parsed(raw.frames[0]!);
    expect(response.ok).toBe(false);
    await raw.untilClosed;
    expect(raw.closed()).toBe(true);
  });

  it('keeps the local pipe free of auth', async () => {
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
    socket.write(`${JSON.stringify(statusFrame)}\n`);
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(parsed(frames[0]!).ok).toBe(true);
    socket.destroy();
  });
});

describe('client handshake', () => {
  async function startRemoteBackend(): Promise<number> {
    const host = await makeHost();
    const port = await listenRemoteFor(host);
    await host.start();
    return port;
  }

  function writeRegistry(entry: { host: string; port: number; token?: string }): void {
    writeFileSync(join(root, 'backends.json'), JSON.stringify({ active: 'test', backends: { test: entry } }));
  }

  async function attachClient() {
    const { connectDaemonSession } = await import('../src/daemon-client.js');
    const client = await connectDaemonSession(root, { isolatedSession: true });
    clients.push(client);
    return client;
  }

  it('attaches over TCP using the token from the registry', async () => {
    const { createAuthToken } = await import('../src/auth-tokens.js');
    const { token } = createAuthToken();
    const port = await startRemoteBackend();
    writeRegistry({ host: '127.0.0.1', port, token });
    const client = await attachClient();
    expect(client.getSnapshot().session.id).toBeTruthy();
  });

  it('fails to attach when the registry token is wrong', async () => {
    const { createAuthToken } = await import('../src/auth-tokens.js');
    createAuthToken();
    const port = await startRemoteBackend();
    writeRegistry({ host: '127.0.0.1', port, token: 'obt_wrong-token-wrong-token-wrong' });
    const { connectDaemonSession } = await import('../src/daemon-client.js');
    await expect(connectDaemonSession(root, { isolatedSession: true })).rejects.toThrow(/authenticat/i);
  });

  it('fails to attach to a remote backend that has no token in the registry', async () => {
    const { createAuthToken } = await import('../src/auth-tokens.js');
    createAuthToken();
    const port = await startRemoteBackend();
    writeRegistry({ host: '127.0.0.1', port });
    const { connectDaemonSession } = await import('../src/daemon-client.js');
    await expect(connectDaemonSession(root, { isolatedSession: true })).rejects.toThrow(/authenticat/i);
  });
});
