import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let root: string;
let store: typeof import('../src/session-store.js');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-session-loading-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();
  store = await import('../src/session-store.js');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await (await import('../src/session-writer.js')).closeIdleSessionWriter();
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-session-loading-')) {
    throw new Error('Unsafe session loading fixture path.');
  }
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  return store.saveSession({
    ...store.createSession('fixture', 'fixture', 100_000, root),
    entries: [
      { kind: 'user', text: 'LOAD_HEAVY_MARKER ' + 'x'.repeat(2_000_000) },
      { kind: 'tool', command: 'fixture', result: '', running: true },
    ],
    conversation: [{ role: 'user', content: 'Load fixture' }],
    conversationArchive: [{ role: 'user', content: 'Archived fixture' }],
  });
}

it('loads and repairs a full session identically without parsing it on the controller thread', async () => {
  const saved = fixture();
  const expected = store.loadSavedSession(saved.id);
  const parse = JSON.parse;
  vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    if (text.includes('LOAD_HEAVY_MARKER')) throw new Error('Full session parsed on host thread.');
    return parse(text, reviver);
  });
  const actual = await store.loadSavedSessionAsync(saved.id);
  expect(actual).toEqual(expected);
  expect(actual?.entries[1]).toMatchObject({ running: false, result: 'Execution was interrupted before the result was saved.' });
});

it('keeps missing and invalid-id behavior identical', async () => {
  expect(await store.loadSavedSessionAsync(randomUUID())).toBeNull();
  await expect(store.loadSavedSessionAsync('../outside')).rejects.toThrow('Invalid session id.');
});

it('preserves machine and workspace scope boundaries', async () => {
  const saved = fixture();
  expect(await store.loadSavedSessionAsync(saved.id, null)).toBeNull();
  expect(await store.loadSavedSessionAsync(saved.id, join(root, 'other'))).toBeNull();
  expect((await store.loadSavedSessionAsync(saved.id, root))?.id).toBe(saved.id);
  expect(await store.loadSessionForChatAsync(saved.id, join(root, 'other'))).toBeNull();
  expect((await store.loadSessionForChatAsync(saved.id, root))?.id).toBe(saved.id);
});

it('reports corrupt JSON and unsupported records without exposing transcript bytes', async () => {
  const saved = fixture();
  const file = store.listSessionFiles().find((candidate) => candidate.id === saved.id)!;
  writeFileSync(file.path, '{"private":"sensitive-fixture" broken');
  await expect(store.loadSavedSessionAsync(saved.id)).rejects.toThrow('This session file is invalid or unsupported.');
  writeFileSync(file.path, JSON.stringify({ version: 999, id: saved.id }));
  await expect(store.loadSavedSessionAsync(saved.id)).rejects.toThrow('This session file is invalid or unsupported.');
});
