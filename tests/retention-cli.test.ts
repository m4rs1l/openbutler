import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-retention-cli-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-retention-cli-')) {
    throw new Error('Unsafe retention fixture cleanup path.');
  }
  rmSync(root, { recursive: true, force: true });
});

function runCli(args: string[]): Promise<{ code: number | null; output: string }> {
  const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
  const child = spawn(process.execPath, ['--import', loader, resolve('src/cli.ts'), ...args], {
    cwd: root,
    env: { ...process.env, OPENBUTLER_DATA_DIR: root, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return new Promise((resolveRun, rejectRun) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error('Retention CLI fixture timed out.'));
    }, 20_000);
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, output });
    });
  });
}

async function oldSession(id?: string) {
  const { createSession, saveSession, listSessionFiles } = await import('../src/session-store.js');
  const saved = saveSession({
    ...createSession('fixture', 'fixture'),
    ...(id ? { id } : {}),
    entries: [{ kind: 'user', text: 'keep history' }],
  });
  const file = listSessionFiles().find((candidate) => candidate.id === saved.id)!;
  const old = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(file.path, old, old);
  return file;
}

it('refuses session deletion while a host PID is still alive, but permits a read-only preview', async () => {
  const file = await oldSession();
  writeFileSync(join(root, 'daemon.pid'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const preview = await runCli(['sessions', 'prune', '--older-than', '1d']);
  expect(preview.code).toBe(0);
  expect(preview.output).toContain('Nothing was deleted');
  const removal = await runCli(['sessions', 'prune', '--older-than', '1d', '--yes']);
  expect(removal.code).not.toBe(0);
  expect(removal.output).toContain('Stop the background host first');
  expect(existsSync(file.path)).toBe(true);
}, 30_000);

it('deletes an explicitly selected old chat offline and never deletes the custodian', async () => {
  const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
  const chat = await oldSession();
  const custodian = await oldSession(CUSTODIAN_SESSION_ID);
  const result = await runCli(['sessions', 'prune', '--older-than', '1d', '--yes']);
  expect(result.code).toBe(0);
  expect(existsSync(chat.path)).toBe(false);
  expect(existsSync(custodian.path)).toBe(true);
}, 30_000);

it('does not migrate an older ledger schema when previewing action retention', async () => {
  const { ActivityLedger } = await import('../src/activity-ledger.js');
  const path = join(root, 'state.db');
  const ledger = new ActivityLedger(path);
  ledger.close();
  const database = new DatabaseSync(path);
  database.exec('ALTER TABLE openbutler_actions DROP COLUMN event_id');
  const before = database.prepare('PRAGMA schema_version').get();
  database.close();
  const result = await runCli(['actions', 'prune', '--older-than', '1d']);
  expect(result.code).toBe(0);
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    expect(reader.prepare('PRAGMA schema_version').get()).toEqual(before);
    const columns = reader.prepare('PRAGMA table_info(openbutler_actions)').all();
    expect(columns.some((column) => column.name === 'event_id')).toBe(false);
  } finally {
    reader.close();
  }
}, 30_000);
