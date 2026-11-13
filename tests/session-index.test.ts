import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedSession, SessionEntry } from '../src/session-store.js';

/**
 * The session index is derived data: session files stay the source of truth, the
 * index is rebuilt from them, and search must work with or without the local
 * embedding model. Lexical tests run without a model cache; the embedding tests
 * write a fake model cache and mock the ONNX runtime the same way the memory
 * search tests do.
 */

const dimensions = 384;

const fake = vi.hoisted(() => {
  const wordIds = new Map<string, number>();
  const encode = (text: string): number[] => {
    const words = text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
    const ids = words.map((word) => {
      let id = wordIds.get(word);
      if (id === undefined) {
        id = wordIds.size + 1;
        wordIds.set(word, id);
      }
      return id;
    });
    return ids.length > 0 ? ids : [0];
  };
  return {
    encode,
    reset: () => wordIds.clear(),
    session: {
      inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
      outputNames: ['last_hidden_state'],
      release: vi.fn(async () => {}),
      run: vi.fn(async (feeds: Record<string, { data: BigInt64Array; dims: number[] }>) => {
        const ids = feeds.input_ids!.data;
        const [batch, sequence] = feeds.input_ids!.dims;
        const data = new Float32Array(batch! * sequence! * dimensions);
        for (let index = 0; index < ids.length; index++) data[index * dimensions + (Number(ids[index]!) % dimensions)] = 1;
        return { last_hidden_state: { dims: [batch, sequence, dimensions], data } };
      }),
    },
  };
});

vi.mock('onnxruntime-node', () => ({
  InferenceSession: { create: vi.fn(async () => fake.session) },
  Tensor: class {
    constructor(
      readonly type: string,
      readonly data: BigInt64Array,
      readonly dims: number[],
    ) {}
  },
}));

vi.mock('@huggingface/tokenizers', () => ({
  Tokenizer: class {
    encode(text: string) {
      const ids = fake.encode(text);
      return { ids, attention_mask: ids.map(() => 1), token_type_ids: ids.map(() => 0) };
    }
  },
}));

type Store = typeof import('../src/session-store.js');
type SessionIndexModule = typeof import('../src/session-index.js');

let root: string;
let store: Store;
let SessionIndexCtor: SessionIndexModule['SessionIndex'];

beforeEach(async () => {
  fake.reset();
  fake.session.run.mockClear();
  root = mkdtempSync(join(tmpdir(), 'openbutler-session-index-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();
  store = await import('../src/session-store.js');
  SessionIndexCtor = (await import('../src/session-index.js')).SessionIndex;
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-session-index-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(root, { recursive: true, force: true });
});

function saveSession(options: { entries: SessionEntry[]; workspace?: string; title?: string }): SavedSession {
  const base = store.createSession('fixture-provider', 'fixture-model', 262_144, options.workspace ?? root);
  return store.saveSession({
    ...base,
    ...(options.title === undefined ? {} : { title: options.title }),
    entries: options.entries,
  });
}

function sessionPath(id: string): string {
  return join(root, 'sessions', id, `${id}.json`);
}

async function search(query: string, options: Partial<Omit<import('../src/session-index.js').SessionSearchOptions, 'query'>> = {}) {
  const index = new SessionIndexCtor(root);
  try {
    return await index.search({ query, ...options });
  } finally {
    await index.close();
  }
}

function openDb(): DatabaseSync {
  return new DatabaseSync(join(root, 'state.db'));
}

function writeModelCache(): void {
  const directory = join(root, 'models', 'Xenova/all-MiniLM-L6-v2', '751bff37182d3f1213fa05d7196b954e230abad9');
  mkdirSync(join(directory, 'onnx'), { recursive: true });
  for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) {
    writeFileSync(join(directory, file), '{}');
  }
}

/** Mirrors the CLI path: index refresh plus draining the embedding backlog in rounds. */
async function buildEmbeddings(): Promise<void> {
  const index = new SessionIndexCtor(root);
  try {
    await index.ensureIndexed();
    while ((await index.embedPending()) > 0) {
      // Drain the whole backlog; the per-run cap only bounds one call.
    }
  } finally {
    await index.close();
  }
}

/** A populated pre-external-content database, including a previously embedded row. */
async function seedLegacyIndex(): Promise<SavedSession> {
  const { EMBEDDING_RUNTIME_KEY } = await import('../src/memory-index.js');
  const token = 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
  const text = `Earlier context ${'padding words '.repeat(20)}migrationalpha Crème brûlée ${token} final context`;
  const session = saveSession({
    title: `Legacy title ${token}`,
    entries: [
      { kind: 'user', text },
      { kind: 'assistant', text: 'migrationalpha second reply' },
      { kind: 'tool', command: 'legacycommand run', result: 'legacyoutput payload' },
    ],
  });
  const file = store.listSessionFiles().find((candidate) => candidate.id === session.id)!;
  const vector = new Float32Array(dimensions);
  vector[7] = 1;
  const database = openDb();
  try {
    database.exec(`
      PRAGMA user_version = 37;
      CREATE TABLE unrelated_state (value TEXT);
      INSERT INTO unrelated_state VALUES ('untouched');
      CREATE TABLE session_sources (
        session_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT, updated_at TEXT NOT NULL,
        entries_count INTEGER NOT NULL, file_mtime_ms INTEGER NOT NULL, file_size_bytes INTEGER NOT NULL,
        embedding_model_key TEXT NOT NULL DEFAULT '', indexed_at TEXT NOT NULL
      );
      CREATE INDEX session_sources_workspace_idx ON session_sources(workspace_root);
      CREATE TABLE session_entries (
        session_id TEXT NOT NULL, entry INTEGER NOT NULL, chunk INTEGER NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, text_sha TEXT NOT NULL,
        embedding BLOB CHECK(embedding IS NULL OR length(embedding) = ${dimensions * 4}),
        PRIMARY KEY (session_id, entry, chunk)
      ) WITHOUT ROWID;
      CREATE INDEX session_entries_kind_idx ON session_entries(kind);
      CREATE VIRTUAL TABLE session_fts USING fts5(text, session_id UNINDEXED, entry UNINDEXED, chunk UNINDEXED);
    `);
    database
      .prepare('INSERT INTO session_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        session.id,
        session.title,
        session.workspaceRoot!,
        session.updatedAt,
        3,
        Math.floor(file.modifiedAt),
        file.sizeBytes,
        EMBEDDING_RUNTIME_KEY,
        'legacy-indexed-at',
      );
    const rows = [
      { rowid: 41, entry: 1, chunk: 0, kind: 'user', text, embedding: new Uint8Array(vector.buffer) },
      { rowid: 7, entry: 2, chunk: 0, kind: 'assistant', text: 'migrationalpha second reply', embedding: null },
      { rowid: 93, entry: 3, chunk: 0, kind: 'command', text: 'legacycommand run', embedding: null },
      { rowid: 94, entry: 3, chunk: 1, kind: 'output', text: 'legacyoutput payload', embedding: null },
    ];
    for (const row of rows) {
      database
        .prepare('INSERT INTO session_entries VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(session.id, row.entry, row.chunk, row.kind, row.text, createHash('sha256').update(row.text).digest('hex'), row.embedding);
      database
        .prepare('INSERT INTO session_fts (rowid, text, session_id, entry, chunk) VALUES (?, ?, ?, ?, ?)')
        .run(row.rowid, row.text, session.id, row.entry, row.chunk);
    }
  } finally {
    database.close();
  }
  return session;
}

function withDb<T>(callback: (database: DatabaseSync) => T): T {
  const database = openDb();
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function indexSnapshot(database: DatabaseSync) {
  return {
    sources: database.prepare('SELECT * FROM session_sources ORDER BY session_id').all(),
    entries: database
      .prepare(
        `
      SELECT session_id, entry, chunk, kind, text, text_sha, hex(embedding) AS embedding
      FROM session_entries ORDER BY session_id, entry, chunk
    `,
      )
      .all(),
    lexical: database
      .prepare(
        `
      SELECT rowid, session_id, entry, chunk, text, snippet(session_fts, 0, '', '', '…', 16) AS excerpt,
             bm25(session_fts) AS rank
      FROM session_fts WHERE session_fts MATCH 'migrationalpha*' ORDER BY bm25(session_fts), entry, chunk
    `,
      )
      .all(),
    version: database.prepare('PRAGMA user_version').get(),
    unrelated: database.prepare('SELECT * FROM unrelated_state').all(),
  };
}

function expectNoFtsMatches(database: DatabaseSync, query: string): void {
  expect(database.prepare('SELECT rowid FROM session_fts WHERE session_fts MATCH ?').all(query)).toEqual([]);
  database.exec("INSERT INTO session_fts(session_fts, rank) VALUES ('integrity-check', 1)");
}

describe('session index: lossless external-content migration', () => {
  it('upgrades populated legacy storage without changing text, vectors, metadata, excerpts, or ranking', async () => {
    const session = await seedLegacyIndex();
    const before = withDb(indexSnapshot);
    const legacyIds = withDb((database) =>
      database.prepare('SELECT rowid, session_id, entry, chunk FROM session_fts ORDER BY rowid').all(),
    );

    const result = await search('migrationalpha');
    expect(result.indexedEmbeddings).toBe(1);
    expect(result.pendingEmbeddings).toBe(0);
    expect(result.matches.map((match) => match.entry)).toEqual(before.lexical.map((row) => row.entry));
    const user = result.matches.find((match) => match.entry === 1)!;
    expect(user).toMatchObject({
      sessionId: session.id,
      entry: 1,
      kind: 'user',
      workspaceRoot: session.workspaceRoot,
      updatedAt: session.updatedAt,
      score: 1.2,
    });
    expect(user.snippet).toContain('migrationalpha Crème brûlée [redacted]');
    expect(user.snippet).toContain('…');
    expect(JSON.stringify(result)).not.toContain('ghp_');
    expect(fake.session.run).not.toHaveBeenCalled();
    expect((await search('legacyoutput', { includeOutputs: true })).matches[0]).toMatchObject({ entry: 3, kind: 'output' });

    withDb((database) => {
      expect(indexSnapshot(database)).toEqual(before);
      expect(
        database.prepare('SELECT content_id AS rowid, session_id, entry, chunk FROM session_entries ORDER BY content_id').all(),
      ).toEqual(legacyIds);
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'session_fts_content'").get()).toBeUndefined();
      expect(database.prepare('PRAGMA table_info(session_entries)').all()).toContainEqual(
        expect.objectContaining({
          name: 'content_id',
          type: 'INTEGER',
          pk: 1,
        }),
      );
      expect(() =>
        database.exec(`
        INSERT INTO session_entries (session_id, entry, chunk, kind, text, text_sha, embedding)
        SELECT session_id, entry, chunk, kind, text, text_sha, embedding FROM session_entries LIMIT 1
      `),
      ).toThrow(/UNIQUE/);
      database.exec("INSERT INTO session_fts(session_fts, rank) VALUES ('integrity-check', 1)");
    });
  });

  it('preserves legacy rowid ordering for tied lexical ranks', async () => {
    await seedLegacyIndex();
    withDb((database) => {
      const row = database.prepare('SELECT text, text_sha FROM session_entries WHERE entry = 1').get() as {
        text: string;
        text_sha: string;
      };
      database.prepare('UPDATE session_entries SET text = ?, text_sha = ? WHERE entry = 2').run(row.text, row.text_sha);
      database.prepare('UPDATE session_fts SET text = ? WHERE entry = 2').run(row.text);
      expect(
        database.prepare("SELECT entry FROM session_fts WHERE session_fts MATCH 'migrationalpha' ORDER BY bm25(session_fts)").all(),
      ).toEqual([{ entry: 2 }, { entry: 1 }]);
    });
    expect((await search('migrationalpha')).matches.map((match) => match.entry)).toEqual([2, 1]);
  });

  it.each(['missing postings', 'missing table'])('copies every legacy content row even with %s', async (mode) => {
    await seedLegacyIndex();
    const before = withDb(indexSnapshot);
    withDb((database) => database.exec(mode === 'missing table' ? 'DROP TABLE session_fts' : 'DELETE FROM session_fts WHERE entry = 1'));
    const result = await search('migrationalpha');
    expect(result.total).toBe(2);
    expect(result.indexedEntries).toBe(4);
    expect(result.indexedEmbeddings).toBe(1);
    withDb((database) => {
      const after = indexSnapshot(database);
      expect(after.entries).toEqual(before.entries);
      expect(after.sources).toEqual(before.sources);
      database.exec("INSERT INTO session_fts(session_fts, rank) VALUES ('integrity-check', 1)");
    });
  });

  it.each(['missing', 'internal'])('reopens idempotently and repairs %s FTS without replacing content IDs or vectors', async (mode) => {
    await seedLegacyIndex();
    await search('migrationalpha');
    const before = withDb(indexSnapshot);
    const ids = withDb((database) => database.prepare('SELECT content_id FROM session_entries ORDER BY content_id').all());
    const postings = withDb((database) => database.prepare('SELECT id, hex(block) AS block FROM session_fts_data ORDER BY id').all());

    await search('migrationalpha');
    withDb((database) => {
      expect(database.prepare('SELECT id, hex(block) AS block FROM session_fts_data ORDER BY id').all()).toEqual(postings);
      database.exec('DROP TABLE session_fts');
      if (mode === 'internal') {
        database.exec(`
          CREATE VIRTUAL TABLE session_fts USING fts5(text, session_id UNINDEXED, entry UNINDEXED, chunk UNINDEXED);
          INSERT INTO session_fts (text, session_id, entry, chunk) SELECT text, session_id, entry, chunk FROM session_entries;
        `);
      }
    });

    expect((await search('migrationalpha')).indexedEmbeddings).toBe(1);
    withDb((database) => {
      expect(indexSnapshot(database)).toEqual(before);
      expect(database.prepare('SELECT content_id FROM session_entries ORDER BY content_id').all()).toEqual(ids);
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'session_fts_content'").get()).toBeUndefined();
      database.exec("INSERT INTO session_fts(session_fts, rank) VALUES ('integrity-check', 1)");
    });
  });

  it('rolls back a failed postings rebuild and retries migration on the same instance', async () => {
    await seedLegacyIndex();
    const before = withDb(indexSnapshot);
    const originalExec = DatabaseSync.prototype.exec;
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (/VALUES\s*\('rebuild'\)/i.test(sql)) throw new Error('injected FTS rebuild failure');
      return originalExec.call(this, sql);
    });
    const index = new SessionIndexCtor(root);
    try {
      expect(() => index.collectCounts()).toThrow('injected FTS rebuild failure');
      exec.mockRestore();
      withDb((database) => {
        expect(indexSnapshot(database)).toEqual(before);
        expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'session_fts_content'").get()).toBeDefined();
        expect(database.prepare('PRAGMA table_info(session_entries)').all()).not.toContainEqual(
          expect.objectContaining({ name: 'content_id' }),
        );
        expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'session_entries_migration'").get()).toBeUndefined();
      });
      expect(index.collectCounts()).toMatchObject({ sessions: 1, entries: 4, embeddings: 1 });
    } finally {
      exec.mockRestore();
      await index.close();
    }
    expect((await search('migrationalpha')).total).toBe(2);
  });

  it('refreshes and prunes transactionally with no ghost postings', async () => {
    const session = await seedLegacyIndex();
    await search('migrationalpha');
    const before = withDb(indexSnapshot);
    withDb((database) =>
      database.exec(`CREATE TRIGGER block_refresh BEFORE DELETE ON session_entries BEGIN
      SELECT RAISE(ABORT, 'blocked refresh'); END;`),
    );
    const updated = store.loadSavedSession(session.id)!;
    updated.entries = [{ kind: 'user', text: 'replacementmarker updated content' }];
    store.saveSession(updated);
    await expect(search('replacementmarker')).rejects.toThrow('blocked refresh');
    withDb((database) => {
      expect(indexSnapshot(database)).toEqual(before);
      database.exec('DROP TRIGGER block_refresh');
    });

    expect((await search('replacementmarker')).total).toBe(1);
    expect((await search('migrationalpha')).total).toBe(0);
    const refreshed = withDb((database) => {
      expectNoFtsMatches(database, 'migrationalpha OR legacycommand OR legacyoutput');
      database.exec(`CREATE TRIGGER block_prune BEFORE DELETE ON session_sources BEGIN
        SELECT RAISE(ABORT, 'blocked prune'); END;`);
      return indexSnapshot(database);
    });

    const index = new SessionIndexCtor(root);
    try {
      expect(() => index.removeSessions([session.id])).toThrow('blocked prune');
      withDb((database) => {
        expect(indexSnapshot(database)).toEqual(refreshed);
        expect(database.prepare("SELECT rowid FROM session_fts WHERE session_fts MATCH 'replacementmarker'").all()).toHaveLength(1);
        database.exec('DROP TRIGGER block_prune');
      });
      rmSync(sessionPath(session.id));
      index.removeSessions([session.id]);
      expect(index.collectCounts()).toMatchObject({ sessions: 0, entries: 0, embeddings: 0 });
    } finally {
      await index.close();
    }
    withDb((database) => expectNoFtsMatches(database, 'replacementmarker'));
  });
});

describe('session index: lexical search', () => {
  it('finds user, assistant, and command entries with display numbering', async () => {
    saveSession({
      entries: [
        { kind: 'user', text: 'start the subtitle pipeline' },
        { kind: 'tool', command: 'npm run build', result: 'ok' },
        { kind: 'assistant', text: 'pipeline rebuilt cleanly' },
      ],
    });

    const user = await search('subtitle');
    expect(user.total).toBe(1);
    expect(user.matches[0]).toMatchObject({ entry: 1, kind: 'user' });
    expect(user.matches[0]!.snippet).toContain('subtitle pipeline');
    expect(user.matches[0]!.score).toBeGreaterThan(0);
    expect(user.indexedSessions).toBe(1);
    expect(user.indexedEntries).toBe(4);
    expect(user.indexedEmbeddings).toBe(0);

    const command = await search('npm');
    expect(command.matches[0]).toMatchObject({ entry: 2, kind: 'command' });

    const assistant = await search('rebuilt');
    expect(assistant.matches[0]).toMatchObject({ entry: 3, kind: 'assistant' });
  });

  it('skips reasoning entries for matching and numbering', async () => {
    saveSession({
      entries: [
        { kind: 'user', text: 'first note' },
        { kind: 'reasoning', text: 'hidden deliberation' },
        { kind: 'assistant', text: 'target phrase' },
      ],
    });

    const hit = await search('target');
    expect(hit.matches[0]).toMatchObject({ entry: 2, kind: 'assistant' });
    expect((await search('hidden')).total).toBe(0);
  });

  it('excludes tool outputs by default and includes them on request', async () => {
    saveSession({
      entries: [
        { kind: 'user', text: 'run the tests' },
        { kind: 'tool', command: 'npm test', result: 'uniqueoutputtoken failed twice' },
        { kind: 'assistant', text: 'tests failed' },
      ],
    });

    const excluded = await search('uniqueoutputtoken');
    expect(excluded.total).toBe(0);
    expect(excluded.matches).toEqual([]);

    const included = await search('uniqueoutputtoken', { includeOutputs: true });
    expect(included.total).toBe(1);
    expect(included.matches[0]).toMatchObject({ entry: 2, kind: 'output' });
    expect(included.matches[0]!.snippet).toContain('uniqueoutputtoken');
  });

  it('matches accented text across case and diacritics', async () => {
    saveSession({ entries: [{ kind: 'user', text: 'Crème brûlée recipe corrected' }] });

    expect((await search('creme')).total).toBe(1);
    expect((await search('BRÛLÉE')).total).toBe(1);
  });

  it('spans every workspace by default and narrows with scope', async () => {
    saveSession({ entries: [{ kind: 'user', text: 'local project fix' }] });
    saveSession({ entries: [{ kind: 'user', text: 'remote project fix' }], workspace: join(root, 'other') });

    const all = await search('project');
    expect(all.total).toBe(2);
    expect(all.indexedSessions).toBe(2);

    const narrowed = await search('project', { scope: 'workspace' });
    expect(narrowed.total).toBe(1);
    expect(narrowed.matches[0]!.workspaceRoot).toBe(resolve(root));
  });

  it('paginates with limit and offset', async () => {
    saveSession({
      entries: [
        { kind: 'user', text: 'alpha one' },
        { kind: 'assistant', text: 'alpha two' },
        { kind: 'user', text: 'alpha three' },
      ],
    });

    const first = await search('alpha', { limit: 1 });
    expect(first.total).toBe(3);
    expect(first.matches).toHaveLength(1);
    expect(first.nextOffset).toBe(1);

    const second = await search('alpha', { limit: 2, offset: 1 });
    expect(second.matches).toHaveLength(2);
    expect(second.nextOffset).toBeUndefined();
  });

  it('redacts secrets in titles and snippets', async () => {
    const token = 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
    saveSession({ entries: [{ kind: 'user', text: `deploy token ${token} please` }] });

    const result = await search('deploy');
    expect(result.total).toBe(1);
    expect(result.matches[0]!.title).not.toContain('ghp_');
    expect(result.matches[0]!.snippet).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toContain('ghp_');
  });

  it('returns no matches for an unknown token and rejects an empty query', async () => {
    saveSession({ entries: [{ kind: 'user', text: 'ordinary note' }] });
    expect((await search('kubernetes')).total).toBe(0);
    await expect(search('   ')).rejects.toThrow('non-empty');
  });

  it('counts sessions and entries after indexing', async () => {
    saveSession({ entries: [{ kind: 'user', text: 'one entry' }] });
    saveSession({ entries: [{ kind: 'user', text: 'another entry' }] });
    const result = await search('entry');
    expect(result.indexedSessions).toBe(2);
    expect(result.indexedEntries).toBe(2);
  });
});

describe('session index: refresh, prune, and rebuild', () => {
  it('skips unchanged files using mtime and size', async () => {
    saveSession({ entries: [{ kind: 'user', text: 'stable content here' }] });
    expect((await search('stable')).total).toBe(1);

    let database = openDb();
    database.prepare("UPDATE session_sources SET indexed_at = 'sentinel'").run();
    database.close();

    expect((await search('stable')).total).toBe(1);
    database = openDb();
    const row = database.prepare('SELECT indexed_at FROM session_sources').get() as { indexed_at: string };
    database.close();
    expect(row.indexed_at).toBe('sentinel');
  });

  it('removes rows when a session file is deleted', async () => {
    const session = saveSession({ entries: [{ kind: 'user', text: 'temporary marker' }] });
    expect((await search('temporary')).total).toBe(1);

    rmSync(sessionPath(session.id));
    const after = await search('temporary');
    expect(after.total).toBe(0);
    expect(after.indexedSessions).toBe(0);
  });

  it('drops rows for a damaged session file', async () => {
    const session = saveSession({ entries: [{ kind: 'user', text: 'healthy content' }] });
    expect((await search('healthy')).total).toBe(1);

    writeFileSync(sessionPath(session.id), '{ not valid json');
    const after = await search('healthy');
    expect(after.total).toBe(0);
    expect(after.indexedSessions).toBe(0);
  });

  it('removeSessions drops rows on demand', async () => {
    const first = saveSession({ entries: [{ kind: 'user', text: 'firstmarker note' }] });
    saveSession({ entries: [{ kind: 'user', text: 'secondmarker note' }] });

    const index = new SessionIndexCtor(root);
    try {
      await index.ensureIndexed();
      // The prune flow deletes the file first, then the derived rows.
      rmSync(sessionPath(first.id));
      index.removeSessions([first.id]);
      const counts = index.collectCounts();
      expect(counts.sessions).toBe(1);
      expect(counts.entries).toBe(1);
    } finally {
      await index.close();
    }
    expect((await search('firstmarker')).total).toBe(0);
    expect((await search('secondmarker')).total).toBe(1);
  });

  it('rebuild drops derived rows and ensureIndexed recreates them', async () => {
    saveSession({ entries: [{ kind: 'user', text: 'rebuildable content' }] });
    const index = new SessionIndexCtor(root);
    try {
      await index.ensureIndexed();
      expect(index.collectCounts().sessions).toBe(1);

      index.rebuild();
      expect(index.collectCounts().sessions).toBe(0);

      await index.ensureIndexed();
      const counts = index.collectCounts();
      expect(counts.sessions).toBe(1);
      expect(counts.entries).toBe(1);
    } finally {
      await index.close();
    }
  });
});

describe('session index: embeddings (mocked local model)', () => {
  it('embeds user entries only and marks the model key', async () => {
    writeModelCache();
    const { EMBEDDING_RUNTIME_KEY } = await import('../src/memory-index.js');
    saveSession({
      entries: [
        { kind: 'user', text: 'alpha message for embedding' },
        { kind: 'tool', command: 'npm test', result: 'result body' },
        { kind: 'assistant', text: 'beta reply for embedding' },
      ],
    });

    await buildEmbeddings();
    const result = await search('alpha');
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.indexedEmbeddings).toBe(1);
    expect(result.pendingEmbeddings).toBe(0);

    const database = openDb();
    const rows = database.prepare('SELECT kind, embedding IS NULL AS missing FROM session_entries ORDER BY entry').all() as Array<{
      kind: string;
      missing: number;
    }>;
    const key = database.prepare('SELECT embedding_model_key FROM session_sources').get() as { embedding_model_key: string };
    database.close();

    expect(rows).toEqual([
      { kind: 'user', missing: 0 },
      { kind: 'command', missing: 1 },
      { kind: 'output', missing: 1 },
      { kind: 'assistant', missing: 1 },
    ]);
    expect(key.embedding_model_key).toBe(EMBEDDING_RUNTIME_KEY);
  });

  it('reuses unchanged vectors when the session grows', async () => {
    writeModelCache();
    const session = saveSession({
      entries: [
        { kind: 'user', text: 'alpha reusable vector' },
        { kind: 'assistant', text: 'beta reply' },
      ],
    });
    await buildEmbeddings();

    const readVector = (): string => {
      const database = openDb();
      const row = database.prepare("SELECT hex(embedding) AS vector FROM session_entries WHERE kind = 'user'").get() as {
        vector: string;
      };
      database.close();
      return row.vector;
    };
    const before = readVector();
    expect(before).not.toBe('');

    const reloaded = store.loadSavedSession(session.id);
    reloaded!.entries.push({ kind: 'assistant', text: 'gamma addition' });
    store.saveSession(reloaded!);

    await buildEmbeddings();
    const result = await search('alpha');
    expect(result.indexedEmbeddings).toBe(1);
    expect(result.pendingEmbeddings).toBe(0);
    expect(readVector()).toBe(before);
  });

  it('recalls a row the lexical index cannot see through its stored vector', async () => {
    writeModelCache();
    const session = saveSession({ entries: [{ kind: 'user', text: 'alpha semantic recall' }] });
    await buildEmbeddings();

    const database = openDb();
    database.prepare('DELETE FROM session_fts WHERE session_id = ?').run(session.id);
    database.close();

    const result = await search('alpha');
    expect(result.total).toBe(1);
    expect(result.matches[0]).toMatchObject({ sessionId: session.id, entry: 1, kind: 'user' });
    expect(result.matches[0]!.score).toBeGreaterThan(0.3);
    expect(result.matches[0]!.snippet).toContain('alpha semantic recall');
  });

  it('searches lexically when the model is not prepared', async () => {
    saveSession({ entries: [{ kind: 'user', text: 'lexical only content' }] });
    const result = await search('lexical');
    expect(result.total).toBe(1);
    expect(result.indexedEmbeddings).toBe(0);
    expect(result.pendingEmbeddings).toBe(1);
  });
});
