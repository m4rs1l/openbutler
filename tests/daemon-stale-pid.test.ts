import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-stale-pid-check-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-stale-pid-check-'))
    throw new Error('Unsafe stale-pid fixture cleanup path.');
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function writePidRecord(record: { pid: number; startedAt: string; identity?: string }): void {
  writeFileSync(join(root, 'daemon.pid'), JSON.stringify(record), { mode: 0o600 });
}

describe('stale host pid record', () => {
  it('prunes a record whose live pid is provably a different process (recycled pid)', async () => {
    const { getDaemonStatus } = await import('../src/daemon.js');
    // This test runner is alive but is not the recorded host: its real process
    // identity cannot equal the bogus one stored here, so the record is stale.
    writePidRecord({ pid: process.pid, startedAt: new Date().toISOString(), identity: 'not-this-process-identity' });
    const status = await getDaemonStatus();
    expect(status).toBeNull();
    expect(existsSync(join(root, 'daemon.pid'))).toBe(false);
  }, 20_000);

  it('still reports unresponsive when the record carries no identity to verify against', async () => {
    const { getDaemonStatus } = await import('../src/daemon.js');
    writePidRecord({ pid: process.pid, startedAt: new Date().toISOString() });
    const status = await getDaemonStatus();
    expect(status?.unresponsive).toBe(true);
    expect(status?.pid).toBe(process.pid);
    // An unverifiable record is preserved, not pruned.
    expect(existsSync(join(root, 'daemon.pid'))).toBe(true);
  }, 20_000);

  it('ignores a record whose pid is no longer alive', async () => {
    const { getDaemonStatus } = await import('../src/daemon.js');
    // A pid that cannot exist: well above the platform's pid range.
    writePidRecord({ pid: 0x7fffffff, startedAt: new Date().toISOString(), identity: 'gone' });
    const status = await getDaemonStatus();
    expect(status).toBeNull();
  }, 20_000);
});
