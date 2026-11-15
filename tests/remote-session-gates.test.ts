import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * A paired backend owns the session: with an active backend the CLI must not
 * demand a local host or a local model (the remote host enforces its own), and
 * it must send the host's workspace question to the host — omitting
 * `workspaceRoot` so the host picks its own default, and passing an explicit
 * `--workspace` through untouched for the host to validate against its own
 * filesystem. These pins cover both halves: the skipped local gates, the
 * attach payload, and the host-side validation message.
 */
const root = mkdtempSync(join(tmpdir(), 'ob-remote-gates-'));
vi.stubEnv('OPENBUTLER_DATA_DIR', root);

let captured = '';
const servers: Server[] = [];
const sockets: Socket[] = [];

async function startFakeBackend(): Promise<number> {
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {
      // A killed child resets the connection; the capture already has the frame.
    });
    socket.on('data', (chunk: Buffer) => {
      captured += chunk.toString('utf8');
    });
  });
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No port.');
  return address.port;
}

/** A registry whose active entry has no token, so the client skips the handshake. */
function writeRegistry(port: number): void {
  writeFileSync(join(root, 'backends.json'), JSON.stringify({ active: 'fake-host', backends: { 'fake-host': { host: '127.0.0.1', port } } }), 'utf8');
}

async function cli(args: string[], timeoutMs = 15_000): Promise<{ code: number | null; out: string; err: string }> {
  const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ['--import', loader, resolve('src/cli.ts'), ...args], {
      env: { ...process.env, OPENBUTLER_DATA_DIR: root },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolveChild({ code: null, out, err });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectChild(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveChild({ code, out, err });
    });
  });
}

afterAll(() => {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
});

describe('one-shot request flag', () => {
  it('advertises --ask with a plain one-shot description, not sales copy', async () => {
    const result = await cli(['--help']);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('--ask');
    expect(result.out).toContain('One-shot request');
    expect(result.out).not.toContain('it can select available tools');
  }, 30_000);
});

describe('paired-backend session gates', () => {
  it('skips the local host and local model gates and sends the attach to the paired backend', async () => {
    const port = await startFakeBackend();
    writeRegistry(port);
    const result = await cli(['--ask', 'fixture request']);
    const output = `${result.out}\n${result.err}`;
    // Both local gates must be gone: neither a model setup wall nor a local
    // daemon requirement may appear while a backend is paired.
    expect(output).not.toMatch(/Configure a default model first/);
    expect(output).not.toMatch(/background host is not running/i);
    expect(captured).toContain('"action":"attach"');
    // No --workspace was given: the host decides which workspace runs.
    expect(captured).not.toContain('"workspaceRoot"');
  }, 30_000);

  it('passes an explicit --workspace to the host untouched for the host to validate', async () => {
    captured = '';
    const port = await startFakeBackend();
    writeRegistry(port);
    const result = await cli(['--ask', 'fixture request', '--workspace', 'D:/srv/proj']);
    const output = `${result.out}\n${result.err}`;
    expect(output).not.toMatch(/background host is not running/i);
    // Forward slashes survive only when the client forwards the value verbatim;
    // local canonicalization would have rewritten them.
    expect(captured).toContain('"workspaceRoot":"D:/srv/proj"');
  }, 30_000);
});

describe('host-side workspace validation', () => {
  it('accepts an absolute path, allows omission, and refuses a relative one with guidance', async () => {
    const { validateAttachWorkspaceRoot } = await import('../src/daemon-host.js');
    expect(validateAttachWorkspaceRoot(undefined)).toBeUndefined();
    expect(validateAttachWorkspaceRoot('C:\\srv\\proj')).toBe('C:\\srv\\proj');
    expect(() => validateAttachWorkspaceRoot('relative/x')).toThrow(/absolute path on this host/);
    expect(() => validateAttachWorkspaceRoot('relative/x')).toThrow(/Omit workspaceRoot/);
  });
});
