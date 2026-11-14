import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The token store must be replaced atomically: a crash halfway through a write
 * may leave the previous store, never half of the new one. The pin is the
 * mechanism itself - write to a temp file in the same directory, rename it
 * into place - observed through spied fs calls, with the real functions still
 * running so the on-disk result is verified in the same test.
 */

const fsCalls = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => {
      fsCalls.writeFileSync(...args);
      return (actual.writeFileSync as (...inner: unknown[]) => void)(...args);
    },
    renameSync: (...args: unknown[]) => {
      fsCalls.renameSync(...args);
      return (actual.renameSync as (...inner: unknown[]) => void)(...args);
    },
  };
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-tokenstore-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  fsCalls.writeFileSync.mockClear();
  fsCalls.renameSync.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-tokenstore-'))
    throw new Error('Unsafe fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

describe('auth token store atomicity', () => {
  it('mints by writing a temp file and renaming it into place, never writing the store directly', async () => {
    const storePath = join(root, 'auth-tokens.json');
    const { createAuthToken } = await import('../src/auth-tokens.js');
    const { id, token } = createAuthToken();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(token).toMatch(/^obt_[A-Za-z0-9_-]{32}$/);

    expect(fsCalls.renameSync).toHaveBeenCalledTimes(1);
    const [tmp, target] = fsCalls.renameSync.mock.calls[0]! as [string, string];
    expect(target).toBe(storePath);
    expect(tmp.startsWith(`${storePath}.`)).toBe(true);
    expect(tmp.endsWith('.tmp')).toBe(true);

    // The final path is only ever produced by the rename, so an interrupted
    // write cannot leave a half-written store where the reader looks.
    const direct = fsCalls.writeFileSync.mock.calls.filter(([path]) => String(path) === storePath);
    expect(direct).toEqual([]);

    // The finished store is the exact file the reader accepts, and the
    // working directory holds nothing besides it.
    expect(JSON.parse(readFileSync(storePath, 'utf8'))).toMatchObject({ version: 1, tokens: [{ id }] });
    expect(readdirSync(root)).toEqual(['auth-tokens.json']);
  });
});
