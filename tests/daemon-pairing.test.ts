import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonHost } from '../src/daemon-host.js';
import { DaemonFrameDecoder } from '../src/daemon-frames.js';
import { DAEMON_PROTOCOL_VERSION, MAX_DAEMON_FRAME_BYTES } from '../src/daemon-protocol.js';

let root: string;
let hosts: DaemonHost[] = [];
let servers: Server[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-pair-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();
  hosts = [];
  servers = [];
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
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const host of hosts) await host.close();
  await Promise.all(servers.map((server) => new Promise<void>((done) => (server.listening ? server.close(() => done()) : done()))));
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-pair-'))
    throw new Error('Unsafe fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

async function makeHost(): Promise<DaemonHost> {
  const { createDaemonHost } = await import('../src/daemon-host.js');
  const host = await createDaemonHost({ startedAt: new Date().toISOString(), requestStop: () => {}, log: () => {} });
  hosts.push(host);
  return host;
}

/** The local pipe every install has, where pairing is started from the host terminal. */
async function listenPipeFor(host: DaemonHost): Promise<void> {
  const daemon = await import('../src/daemon.js');
  const server = createServer((socket) => host.handleConnection(socket));
  servers.push(server);
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(daemon.getDaemonEndpoint(), () => res());
  });
}

/** A TCP listener exactly as `--listen` binds it: remote and auth-gated. */
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
      // The host's frame cap is its own concern; this client never sends one.
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

const parsed = (raw: string) => JSON.parse(raw) as Record<string, unknown>;
const pairFrame = (code: string) => ({ version: DAEMON_PROTOCOL_VERSION, id: 'pair-1', action: 'pair', code });

/** Issues a code through the local pipe, the way `openbutler pair` does. */
async function issueCode(): Promise<string> {
  const daemon = await import('../src/daemon.js');
  const issued = (await daemon.requestHost('pair.create')) as { code: string; expiresAt: number };
  expect(issued.code).toMatch(/^[0-9a-f]{12}$/);
  return issued.code;
}

describe('pairing code issuance', () => {
  it('issues a one-time code over the local pipe with a five-minute expiry', async () => {
    const host = await makeHost();
    await listenPipeFor(host);
    await host.start();
    const daemon = await import('../src/daemon.js');
    const before = Date.now();
    const issued = (await daemon.requestHost('pair.create')) as { code: string; expiresAt: number };
    expect(issued.code).toMatch(/^[0-9a-f]{12}$/);
    expect(issued.expiresAt).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 1_000);
    expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1_000);
    // The code never lands on disk: the host keeps it in memory only.
    expect(() => readFileSync(join(root, 'auth-tokens.json'), 'utf8')).toThrow();
  });
});

describe('remote pairing gate', () => {
  it('exchanges a valid code for a token the host accepts', async () => {
    const host = await makeHost();
    await listenPipeFor(host);
    const port = await listenRemoteFor(host);
    await host.start();
    const code = await issueCode();
    const raw = await openRaw(port);
    raw.send(pairFrame(code));
    await waitFor(() => expect(raw.frames.length).toBeGreaterThan(0));
    const response = parsed(raw.frames[0]!);
    expect(response.id).toBe('pair-1');
    expect(response.ok).toBe(true);
    const result = response.result as Record<string, unknown>;
    expect(String(result.token)).toMatch(/^obt_/);
    const { verifyAuthToken } = await import('../src/auth-tokens.js');
    expect(verifyAuthToken(String(result.token))).toBe(true);
    raw.socket.destroy();
  });

  it('refuses a wrong code and leaves the real one usable', async () => {
    const host = await makeHost();
    await listenPipeFor(host);
    const port = await listenRemoteFor(host);
    await host.start();
    const code = await issueCode();
    const wrong = await openRaw(port);
    wrong.send(pairFrame('ffffffffff00'));
    await waitFor(() => expect(wrong.frames.length).toBeGreaterThan(0));
    expect(parsed(wrong.frames[0]!).ok).toBe(false);
    await wrong.untilClosed;
    expect(wrong.closed()).toBe(true);
    // A failed guess must not burn the code the owner is about to type.
    const right = await openRaw(port);
    right.send(pairFrame(code));
    await waitFor(() => expect(right.frames.length).toBeGreaterThan(0));
    expect(parsed(right.frames[0]!).ok).toBe(true);
    right.socket.destroy();
  });

  it('refuses a code that was already redeemed', async () => {
    const host = await makeHost();
    await listenPipeFor(host);
    const port = await listenRemoteFor(host);
    await host.start();
    const code = await issueCode();
    const first = await openRaw(port);
    first.send(pairFrame(code));
    await waitFor(() => expect(first.frames.length).toBeGreaterThan(0));
    expect(parsed(first.frames[0]!).ok).toBe(true);
    first.socket.destroy();
    const second = await openRaw(port);
    second.send(pairFrame(code));
    await waitFor(() => expect(second.frames.length).toBeGreaterThan(0));
    expect(parsed(second.frames[0]!).ok).toBe(false);
    await second.untilClosed;
    expect(second.closed()).toBe(true);
  });

  it('refuses a code whose five minutes have passed', async () => {
    const host = await makeHost();
    await listenPipeFor(host);
    const port = await listenRemoteFor(host);
    await host.start();
    const code = await issueCode();
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 5 * 60 * 1000 + 1);
    try {
      const raw = await openRaw(port);
      raw.send(pairFrame(code));
      await waitFor(() => expect(raw.frames.length).toBeGreaterThan(0));
      expect(parsed(raw.frames[0]!).ok).toBe(false);
      await raw.untilClosed;
      expect(raw.closed()).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('invalidates an older code when a new one is issued', async () => {
    const host = await makeHost();
    await listenPipeFor(host);
    const port = await listenRemoteFor(host);
    await host.start();
    const oldCode = await issueCode();
    const newCode = await issueCode();
    expect(newCode).not.toBe(oldCode);
    const stale = await openRaw(port);
    stale.send(pairFrame(oldCode));
    await waitFor(() => expect(stale.frames.length).toBeGreaterThan(0));
    expect(parsed(stale.frames[0]!).ok).toBe(false);
    const fresh = await openRaw(port);
    fresh.send(pairFrame(newCode));
    await waitFor(() => expect(fresh.frames.length).toBeGreaterThan(0));
    expect(parsed(fresh.frames[0]!).ok).toBe(true);
    stale.socket.destroy();
    fresh.socket.destroy();
  });
});

describe('client pairing', () => {
  it('pairWithBackend exchanges the code for a token', async () => {
    const host = await makeHost();
    await listenPipeFor(host);
    const port = await listenRemoteFor(host);
    await host.start();
    const code = await issueCode();
    const { pairWithBackend } = await import('../src/daemon-client.js');
    const token = await pairWithBackend('127.0.0.1', port, code);
    expect(token).toMatch(/^obt_/);
    const { verifyAuthToken } = await import('../src/auth-tokens.js');
    expect(verifyAuthToken(token)).toBe(true);
  });

  it('pairs successfully only with a running host', async () => {
    const port = 1; // Nothing listens; the pair must fail cleanly, not hang.
    const { pairWithBackend } = await import('../src/daemon-client.js');
    await expect(pairWithBackend('127.0.0.1', port, 'ffffffffff00')).rejects.toThrow();
  });
});

describe('backend registry writes', () => {
  it('saves and activates a backend the reader resolves back', async () => {
    const { saveBackend, resolveActiveBackend } = await import('../src/backend-registry.js');
    saveBackend('zeus', { host: '100.64.0.5', port: 45280, token: 'obt_round-trip' }, { activate: true });
    expect(resolveActiveBackend()).toEqual({ host: '100.64.0.5', port: 45280, token: 'obt_round-trip' });
  });

  it('writes the credential file with owner-only permissions', async () => {
    const { saveBackend, backendRegistryPath } = await import('../src/backend-registry.js');
    saveBackend('zeus', { host: '100.64.0.5', port: 45280, token: 'obt_secret' }, { activate: true });
    if (process.platform !== 'win32') {
      // POSIX mode bits do not exist on Windows; the read barrier there is the user profile.
      expect(statSync(backendRegistryPath()).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(backendRegistryPath(), 'utf8')).toContain('obt_secret');
  });

  it('leaves the active entry untouched when not asked to activate', async () => {
    const { saveBackend, readBackendRegistry } = await import('../src/backend-registry.js');
    saveBackend('first', { host: '100.64.0.5', port: 1 }, { activate: true });
    saveBackend('second', { host: '100.64.0.6', port: 2 });
    expect(readBackendRegistry().active).toBe('first');
  });

  it('removes a backend and deactivates it when it was active', async () => {
    const { saveBackend, removeBackend, readBackendRegistry } = await import('../src/backend-registry.js');
    saveBackend('zeus', { host: '100.64.0.5', port: 1 }, { activate: true });
    expect(removeBackend('zeus')).toBe(true);
    expect(readBackendRegistry()).toEqual({ active: null, backends: {} });
    expect(removeBackend('zeus')).toBe(false);
  });

  it('activates a saved backend by name and rejects a ghost', async () => {
    const { saveBackend, setActiveBackend, readBackendRegistry } = await import('../src/backend-registry.js');
    saveBackend('zeus', { host: '100.64.0.5', port: 1 });
    saveBackend('helios', { host: '100.64.0.6', port: 2 }, { activate: true });
    setActiveBackend('zeus');
    expect(readBackendRegistry().active).toBe('zeus');
    expect(() => setActiveBackend('ghost')).toThrow(/ghost/);
  });

  it('validates the name and target on save', async () => {
    const { saveBackend } = await import('../src/backend-registry.js');
    expect(() => saveBackend('   ', { host: '100.64.0.5', port: 1 })).toThrow(/name/);
    expect(() => saveBackend('x'.repeat(65), { host: '100.64.0.5', port: 1 })).toThrow(/name/);
    expect(() => saveBackend('lan', { host: '192.168.1.5', port: 1 })).toThrow(/tailnet/);
    expect(() => saveBackend('bad', { host: '100.64.0.5', port: 0 })).toThrow(/1-65535/);
    expect(() => saveBackend('bad-token', { host: '100.64.0.5', port: 1, token: '' })).toThrow(/token/);
  });
});

describe('connect CLI flow', () => {
  it('treats the first word as the backend target and demands a code when none is passed', async () => {
    // Pins the command-word offset: `parsed.words` omits the command itself,
    // and getting this wrong sends --code and every validation down the
    // wrong path. The terminal running vitest has no TTY, so a missing code
    // must fail loudly instead of silently reading the registry.
    const { runConnect } = await import('../src/cli/connect.js');
    const parsed = { command: 'connect', words: ['zeus:45280'], flags: new Map<string, string>(), booleans: new Set<string>() };
    await expect(runConnect(parsed as never)).rejects.toThrow(/--code/);
  });

  it('pairs through runConnect and saves the backend as active', async () => {
    const host = await makeHost();
    await listenPipeFor(host);
    const port = await listenRemoteFor(host);
    await host.start();
    const code = await issueCode();
    const { runConnect } = await import('../src/cli/connect.js');
    const parsed = {
      command: 'connect',
      words: [`127.0.0.1:${String(port)}`],
      flags: new Map<string, string>([['code', code]]),
      booleans: new Set<string>(),
    };
    await runConnect(parsed as never);
    const { resolveActiveBackend } = await import('../src/backend-registry.js');
    expect(resolveActiveBackend()).toMatchObject({ host: '127.0.0.1', port });
  });
});

describe('connect target parsing', () => {
  it('accepts a MagicDNS name with a port', async () => {
    const { parseConnectTarget } = await import('../src/cli/connect.js');
    expect(parseConnectTarget('zeus:45280')).toEqual({ host: 'zeus', port: 45280 });
  });

  it('accepts a tailnet literal with a port', async () => {
    const { parseConnectTarget } = await import('../src/cli/connect.js');
    expect(parseConnectTarget('100.64.0.5:45280')).toEqual({ host: '100.64.0.5', port: 45280 });
  });

  it('refuses a target without a port', async () => {
    const { parseConnectTarget } = await import('../src/cli/connect.js');
    expect(() => parseConnectTarget('zeus')).toThrow(/host:port/);
    expect(() => parseConnectTarget(':45280')).toThrow(/host:port/);
  });

  it('refuses an out-of-range port', async () => {
    const { parseConnectTarget } = await import('../src/cli/connect.js');
    expect(() => parseConnectTarget('zeus:0')).toThrow(/1-65535/);
    expect(() => parseConnectTarget('zeus:70000')).toThrow(/1-65535/);
    expect(() => parseConnectTarget('zeus:http')).toThrow(/1-65535/);
  });

  it('refuses a non-tailnet literal address', async () => {
    const { parseConnectTarget } = await import('../src/cli/connect.js');
    expect(() => parseConnectTarget('192.168.1.5:45280')).toThrow(/tailnet/);
    expect(() => parseConnectTarget('0.0.0.0:45280')).toThrow(/tailnet/);
  });
});
