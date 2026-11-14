import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonHost } from '../src/daemon-host.js';
import type { DaemonSessionConnection } from '../src/daemon-client.js';

let root: string;
let hosts: DaemonHost[];
let servers: Server[];
let clients: DaemonSessionConnection[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-transport-'));
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
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-transport-'))
    throw new Error('Unsafe fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

/** The registry a client reads at connect time; a string is written verbatim to pin corrupt files. */
function writeRegistry(value: unknown): void {
  writeFileSync(join(root, 'backends.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

async function makeHost(): Promise<DaemonHost> {
  const { createDaemonHost } = await import('../src/daemon-host.js');
  const host = await createDaemonHost({ startedAt: new Date().toISOString(), requestStop: () => {}, log: () => {} });
  hosts.push(host);
  return host;
}

/** A TCP listener speaking the daemon protocol, as a `--listen` backend would. Returns its port. */
async function listenTcpFor(host: DaemonHost): Promise<number> {
  const server = createServer((socket) => host.handleConnection(socket));
  servers.push(server);
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Listener has no port.');
  return address.port;
}

/** The local pipe listener every install has, for the back-compat pin. */
async function listenPipeFor(host: DaemonHost): Promise<void> {
  const daemon = await import('../src/daemon.js');
  const server = createServer((socket) => host.handleConnection(socket));
  servers.push(server);
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(daemon.getDaemonEndpoint(), () => res());
  });
}

/** A currently free loopback port. The bind race is the standard ephemeral-port tradeoff. */
async function reservePort(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Listener has no port.');
  await new Promise<void>((done) => server.close(() => done()));
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

async function attachClient() {
  const { connectDaemonSession } = await import('../src/daemon-client.js');
  const client = await connectDaemonSession(root, { isolatedSession: true });
  clients.push(client);
  return client;
}

describe('backend registry', () => {
  it('resolves to the local host when no registry exists', async () => {
    const { resolveActiveBackend } = await import('../src/backend-registry.js');
    expect(resolveActiveBackend()).toBeNull();
  });

  it('resolves the active backend entry', async () => {
    writeRegistry({ active: 'zeus', backends: { zeus: { host: '100.64.0.5', port: 45280 } } });
    const { resolveActiveBackend } = await import('../src/backend-registry.js');
    expect(resolveActiveBackend()).toEqual({ host: '100.64.0.5', port: 45280 });
  });

  it('resolves to the local host when a backend is saved but none is active', async () => {
    writeRegistry({ active: null, backends: { zeus: { host: '100.64.0.5', port: 45280 } } });
    const { resolveActiveBackend } = await import('../src/backend-registry.js');
    expect(resolveActiveBackend()).toBeNull();
  });

  it('reports a corrupt registry instead of silently using the local host', async () => {
    writeRegistry('{{{ not json');
    const { resolveActiveBackend } = await import('../src/backend-registry.js');
    expect(() => resolveActiveBackend()).toThrow(/not valid JSON/);
  });

  it('reports an active name that has no entry', async () => {
    writeRegistry({ active: 'ghost', backends: {} });
    const { resolveActiveBackend } = await import('../src/backend-registry.js');
    expect(() => resolveActiveBackend()).toThrow(/ghost/);
  });

  it('refuses a non-tailnet literal address', async () => {
    writeRegistry({ active: 'lan', backends: { lan: { host: '192.168.1.5', port: 45280 } } });
    const { resolveActiveBackend } = await import('../src/backend-registry.js');
    expect(() => resolveActiveBackend()).toThrow(/tailnet/);
  });

  it('accepts a loopback literal address', async () => {
    writeRegistry({ active: 'local', backends: { local: { host: '127.0.0.1', port: 45280 } } });
    const { resolveActiveBackend } = await import('../src/backend-registry.js');
    expect(resolveActiveBackend()).toEqual({ host: '127.0.0.1', port: 45280 });
  });

  it('refuses an out-of-range port', async () => {
    writeRegistry({ active: 'zeus', backends: { zeus: { host: '100.64.0.5', port: 70000 } } });
    const { resolveActiveBackend } = await import('../src/backend-registry.js');
    expect(() => resolveActiveBackend()).toThrow(/1-65535/);
  });

  it('refuses a wrong-typed active value', async () => {
    writeRegistry({ active: 42, backends: {} });
    const { resolveActiveBackend } = await import('../src/backend-registry.js');
    expect(() => resolveActiveBackend()).toThrow(/active/);
  });
});

describe('transport selection', () => {
  it('attaches to the active backend over TCP instead of the local pipe', async () => {
    const host = await makeHost();
    const port = await listenTcpFor(host);
    await host.start();
    writeRegistry({ active: 'test', backends: { test: { host: '127.0.0.1', port } } });
    const client = await attachClient();
    expect(client.getSnapshot().session.id).toBeTruthy();
  });

  it('attaches to the local pipe when no registry exists', async () => {
    const host = await makeHost();
    await listenPipeFor(host);
    await host.start();
    const client = await attachClient();
    expect(client.getSnapshot().session.id).toBeTruthy();
  });

  it('surfaces a corrupt registry as the connection error instead of falling back to the pipe', async () => {
    writeRegistry('{{{ not json');
    const { connectDaemonSession } = await import('../src/daemon-client.js');
    await expect(connectDaemonSession(root, { isolatedSession: true })).rejects.toThrow(/not valid JSON/);
  });
});

describe('daemon --listen validation', () => {
  it('accepts a tailnet address', async () => {
    const { parseListenTarget } = await import('../src/daemon.js');
    expect(parseListenTarget('100.64.0.5:45280')).toEqual({ host: '100.64.0.5', port: 45280 });
  });

  it('accepts a loopback address', async () => {
    const { parseListenTarget } = await import('../src/daemon.js');
    expect(parseListenTarget('127.0.0.1:1234')).toEqual({ host: '127.0.0.1', port: 1234 });
  });

  it('refuses 0.0.0.0', async () => {
    const { parseListenTarget } = await import('../src/daemon.js');
    expect(() => parseListenTarget('0.0.0.0:45280')).toThrow(/tailnet or loopback/);
  });

  it('refuses a public address', async () => {
    const { parseListenTarget } = await import('../src/daemon.js');
    expect(() => parseListenTarget('203.0.113.7:80')).toThrow(/tailnet or loopback/);
  });

  it('refuses a hostname', async () => {
    const { parseListenTarget } = await import('../src/daemon.js');
    expect(() => parseListenTarget('example.com:80')).toThrow(/IPv4 address and port/);
  });

  it('refuses port 0', async () => {
    const { parseListenTarget } = await import('../src/daemon.js');
    expect(() => parseListenTarget('127.0.0.1:0')).toThrow(/1-65535/);
  });

  it('refuses a port above 65535', async () => {
    const { parseListenTarget } = await import('../src/daemon.js');
    expect(() => parseListenTarget('127.0.0.1:70000')).toThrow(/1-65535/);
  });

  it('refuses an empty spec', async () => {
    const { parseListenTarget } = await import('../src/daemon.js');
    expect(() => parseListenTarget('')).toThrow(/IPv4 address and port/);
  });
});

describe('daemon run options', () => {
  it('reads the --listen value', async () => {
    const { daemonRunOptions } = await import('../src/cli/daemon-args.js');
    const { parseArgs } = await import('../src/cli/args.js');
    expect(daemonRunOptions(parseArgs(['daemon', 'run', '--listen', '100.64.0.5:45280']))).toEqual({
      listen: '100.64.0.5:45280',
    });
  });

  it('omits listen when the flag is absent', async () => {
    const { daemonRunOptions } = await import('../src/cli/daemon-args.js');
    const { parseArgs } = await import('../src/cli/args.js');
    expect(daemonRunOptions(parseArgs(['daemon', 'run']))).toEqual({});
  });

  it('refuses a bare --listen with no value', async () => {
    const { daemonRunOptions } = await import('../src/cli/daemon-args.js');
    const { parseArgs } = await import('../src/cli/args.js');
    expect(() => daemonRunOptions(parseArgs(['daemon', 'run', '--listen']))).toThrow(/needs an IPv4 address and port/);
  });
});

describe('remote listener wiring', () => {
  it('refuses a public listener before anything starts', async () => {
    const daemon = await import('../src/daemon.js');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let run: Promise<void> | null = null;
    try {
      run = daemon.runDaemonProcess({ listen: '0.0.0.0:1' });
      const outcome = await Promise.race([
        run.then(
          () => 'settled',
          (error: unknown) => error,
        ),
        new Promise<'pending'>((done) => setTimeout(() => done('pending'), 3_000)),
      ]);
      expect(outcome).toBeInstanceOf(Error);
      if (outcome instanceof Error) expect(outcome.message).toMatch(/tailnet or loopback/);
      run = null;
      expect(existsSync(daemon.getDaemonEndpoint())).toBe(false);
    } finally {
      if (run) {
        await daemon.requestHost('stop').catch(() => {});
        await Promise.race([run.catch(() => {}), new Promise((done) => setTimeout(done, 8_000))]);
      }
      exitSpy.mockRestore();
    }
  });

  it('binds the validated listener next to the local pipe and serves an attach on it', async () => {
    const daemon = await import('../src/daemon.js');
    const port = await reservePort();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let run: Promise<void> | null = null;
    let runFailure: unknown = null;
    try {
      run = daemon.runDaemonProcess({ listen: `127.0.0.1:${port}` });
      run.catch((error: unknown) => {
        runFailure = error;
      });
      await waitFor(() => {
        if (runFailure) throw runFailure;
        return daemon.requestHost('status');
      });
      // The validated port must actually accept connections; nothing else binds it.
      await new Promise<void>((res, rej) => {
        const probe = createConnection(port, '127.0.0.1');
        probe.once('connect', () => {
          probe.destroy();
          res();
        });
        probe.once('error', rej);
      });
      writeRegistry({ active: 'e2e', backends: { e2e: { host: '127.0.0.1', port } } });
      const client = await attachClient();
      expect(client.getSnapshot().session.id).toBeTruthy();
      await client.close();
      await daemon.requestHost('stop');
      await run;
      run = null;
      expect(existsSync(daemon.getDaemonEndpoint())).toBe(false);
    } finally {
      if (run) {
        await daemon.requestHost('stop').catch(() => {});
        await Promise.race([run.catch(() => {}), new Promise((done) => setTimeout(done, 8_000))]);
      }
      exitSpy.mockRestore();
    }
  });
});
