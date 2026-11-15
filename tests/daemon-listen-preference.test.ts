import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../src/cli/args.js';

/**
 * The backend install keeps its remote listener as install state: `daemon
 * start --listen <addr:port>` records it, `daemon run` binds it with or
 * without a flag, `--no-listen` clears it, and status shows it. These pins
 * cover the preference itself, the run fallback, the settings contract, the
 * status rows (listener + active client backend), `daemon --help`, and one
 * real `daemon start` that must open the listener it was asked for.
 */
const root = mkdtempSync(join(tmpdir(), 'ob-listen-'));
vi.stubEnv('OPENBUTLER_DATA_DIR', root);

async function cli(args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ['--import', loader, resolve('src/cli.ts'), ...args], {
      env: { ...process.env, OPENBUTLER_DATA_DIR: root },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectChild(new Error(`CLI ${args.join(' ')} timed out.\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectChild(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveChild({ code, stdout, stderr });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        rejectPort(new Error('No port assigned.'));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

async function tcpReachable(port: number): Promise<boolean> {
  return new Promise((resolveReach) => {
    const probe = connect({ host: '127.0.0.1', port });
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.removeAllListeners();
      probe.destroy();
      resolveReach(value);
    };
    const timer = setTimeout(() => settle(false), 2_000);
    probe.once('connect', () => settle(true));
    probe.once('error', () => settle(false));
  });
}

describe('daemon listen preference', () => {
  it('turns --listen into a saved preference, --no-listen into a clear, and no flag into keep', async () => {
    const { listenPreference } = await import('../src/cli/daemon-args.js');
    expect(listenPreference(parseArgs(['daemon', 'start', '--listen', '100.64.0.5:45280']))).toEqual({
      kind: 'save',
      value: '100.64.0.5:45280',
    });
    expect(listenPreference(parseArgs(['daemon', 'start', '--no-listen']))).toEqual({ kind: 'clear' });
    expect(listenPreference(parseArgs(['daemon', 'start']))).toEqual({ kind: 'keep' });
    expect(listenPreference(undefined)).toEqual({ kind: 'keep' });
  });

  it('refuses a bare --listen and a --listen/--no-listen pair with the documented message', async () => {
    const { listenPreference } = await import('../src/cli/daemon-args.js');
    expect(() => listenPreference(parseArgs(['daemon', 'start', '--listen']))).toThrow(/--listen needs an IPv4 address and port/);
    expect(() => listenPreference(parseArgs(['daemon', 'start', '--listen', '--no-listen']))).toThrow(/--listen needs an IPv4 address and port|conflict/);
  });

  it('daemon run binds the saved listener when no flag is given', async () => {
    const { defaultSettings, saveSettings } = await import('../src/settings.js');
    const store = defaultSettings();
    store.daemon = { listen: '127.0.0.1:45999' };
    saveSettings(store);
    const { daemonRunOptions } = await import('../src/cli/daemon-args.js');
    expect(daemonRunOptions(parseArgs(['daemon', 'run']))).toEqual({ listen: '127.0.0.1:45999' });
  });

  it('an explicit --listen wins over the saved one and --no-listen disables it for this run', async () => {
    const { daemonRunOptions } = await import('../src/cli/daemon-args.js');
    expect(daemonRunOptions(parseArgs(['daemon', 'run', '--listen', '127.0.0.1:45998']))).toEqual({ listen: '127.0.0.1:45998' });
    expect(daemonRunOptions(parseArgs(['daemon', 'run', '--no-listen']))).toEqual({});
  });

  it('settings.yaml carries daemon.listen through save and load', async () => {
    const { saveSettings, loadSettings } = await import('../src/settings.js');
    const store = loadSettings();
    store.daemon = { listen: '100.64.0.5:45280' };
    saveSettings(store);
    expect(loadSettings().daemon?.listen).toBe('100.64.0.5:45280');
  });

  it('refuses a malformed saved listener with the documented message', async () => {
    const { saveSettings, loadSettings } = await import('../src/settings.js');
    const store = loadSettings();
    store.daemon = { listen: 'not-a-target' };
    saveSettings(store);
    expect(() => loadSettings()).toThrow(/--listen needs an IPv4 address and port|tailnet|out of range/);
    // Leave no poisoned file behind for the tests that follow.
    rmSync(join(root, 'settings.yaml'), { force: true });
  });
});

describe('daemon status extras', () => {
  it('shows the saved listener and the active client backend, and nothing when neither exists', async () => {
    const { saveSettings, loadSettings } = await import('../src/settings.js');
    rmSync(join(root, 'settings.yaml'), { force: true });
    const store = loadSettings();
    saveSettings(store);
    const { statusExtras } = await import('../src/cli/status-extras.js');
    expect(statusExtras()).toEqual([]);
    store.daemon = { listen: '100.64.0.5:45280' };
    saveSettings(store);
    const registry = await import('../src/backend-registry.js');
    registry.saveBackend('test-host', { host: '100.115.65.6', port: 45300 });
    registry.setActiveBackend('test-host');
    const extras = statusExtras();
    const listener = extras.find(([key]) => key === 'Listener');
    expect(listener?.[1]).toContain('100.64.0.5:45280');
    const backend = extras.find(([key]) => key === 'Client backend');
    expect(backend?.[1]).toContain('test-host');
    expect(backend?.[1]).toContain('100.115.65.6:45300');
    expect(backend?.[1]).toMatch(/this machine/i);
  });
});

describe('daemon --help', () => {
  it('prints daemon usage instead of acting like status', async () => {
    const result = await cli(['daemon', '--help']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Usage|Commands/);
    expect(result.stdout).toContain('--listen');
    expect(result.stdout).toContain('--no-listen');
    expect(result.stdout).not.toContain('Background host is not running');
  }, 30_000);
});

describe('daemon start --listen', () => {
  it('persists the preference, prints it, and opens the listener it was asked for', async () => {
    const { saveSettings, loadSettings } = await import('../src/settings.js');
    const store = loadSettings();
    store.providers.fixture = {
      enabled: true,
      keys: ['fixture-only-key'],
      npm: '@ai-sdk/openai-compatible',
      url: 'http://127.0.0.1:1/v1',
      modelSpecs: { fixture: { context: 64000 } },
    };
    store.providerOrder = ['fixture'];
    store.defaultProvider = 'fixture';
    store.defaultModel = 'fixture';
    saveSettings(store);
    const port = await freePort();
    try {
      const start = await cli(['daemon', 'start', '--listen', `127.0.0.1:${port}`]);
      expect(start.code, start.stderr).toBe(0);
      expect(start.stdout).toContain('Listener');
      expect(start.stdout).toContain(`127.0.0.1:${port}`);
      expect(loadSettings().daemon?.listen).toBe(`127.0.0.1:${port}`);
      const status = await cli(['daemon', 'status']);
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain('Listener');
      expect(status.stdout).toContain(`127.0.0.1:${port}`);
      expect(await tcpReachable(port)).toBe(true);
    } finally {
      const stop = await cli(['daemon', 'stop']);
      expect(stop.code, stop.stderr).toBe(0);
    }
  }, 90_000);
});

// The temp data directory is this file's fixture: remove it after the suite.
afterAll(() => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      // A just-stopped host may still hold handles for a moment on Windows.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
});
