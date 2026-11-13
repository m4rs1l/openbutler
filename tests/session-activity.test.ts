import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEnvironment, AgentSessionController } from '../src/agent-session.js';
import type { AgentSessionClient } from '../src/agent-session.js';
import { ToolRegistry } from '../src/tools/registry.js';

type Store = typeof import('../src/session-store.js');

// A new chat the daemon only holds in memory: the store is the only catalog,
// so the web layer must show nothing for it until a message has been saved.
vi.mock('../src/daemon-client.js', () => ({ connectDaemonSession: vi.fn() }));

function runtimeFor(model: MockLanguageModelV3): AgentEnvironment {
  return {
    model,
    workspaceRoot: process.cwd(),
    modelName: 'Local fixture',
    providerId: 'fixture',
    modelId: 'model-a',
    contextWindowTokens: null,
    outputLimitTokens: null,
    supportsVision: false,
    supportsImageToolResult: true,
    reasoningVariants: [],
    reasoningMetadataSource: null,
    reasoningSupport: 'model-unsupported',
    reasoningDefault: 'default',
    reasoningPreference: 'default',
    saveReasoningPreference: () => {},
    showReasoningDefault: true,
    saveShowReasoningPreference: () => {},
    getReasoningProviderOptions: () => ({}),
    getReviewProviderOptions: () => ({}),
    registry: new ToolRegistry(),
    selectModel: async () => {},
    close: async () => {},
  };
}

function withUser(store: Store, text: string) {
  const session = store.createSession('fixture', 'model-a');
  return { ...session, entries: [{ kind: 'user' as const, text }] };
}

let dataDir: string;
let previousDataDir: string | undefined;
let store: Store;
let controller: AgentSessionController | undefined;

beforeEach(async () => {
  previousDataDir = process.env.OPENBUTLER_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'openbutler-session-activity-'));
  process.env.OPENBUTLER_DATA_DIR = dataDir;
  vi.resetModules();
  store = await import('../src/session-store.js');
});

afterEach(async () => {
  await controller?.close();
  await (await import('../src/session-writer.js')).closeIdleSessionWriter();
  controller = undefined;
  if (previousDataDir === undefined) delete process.env.OPENBUTLER_DATA_DIR;
  else process.env.OPENBUTLER_DATA_DIR = previousDataDir;
  if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith('openbutler-session-activity-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('recent ordering reads content activity', () => {
  it('ignores a later file rewrite that carries no conversation activity', () => {
    // Explicit stamps: two sessions born in the same millisecond would fall to
    // the id tiebreak and make the expected order a coin flip.
    const alpha = { ...withUser(store, 'Alpha'), lastActivityAt: '2026-10-27T10:00:00.000Z' };
    const beta = { ...withUser(store, 'Beta'), lastActivityAt: '2026-10-27T10:00:01.000Z' };
    store.saveSession(alpha);
    store.saveSession(beta);

    // Rewrite alpha's file so its updatedAt becomes the newest stamp while its
    // activity stamp stays put: file mechanics must not move the chat.
    const reloaded = store.loadSavedSession(alpha.id)!;
    store.saveSession({ ...reloaded, entries: [...reloaded.entries, { kind: 'user', text: 'again' }] });

    const listed = store.listSavedSessions();
    expect(listed.map((session) => session.id)).toEqual([beta.id, alpha.id]);
    expect(listed[0]!.lastActivityAt).toBe(beta.lastActivityAt);
    expect(listed[1]!.lastActivityAt).toBe(alpha.lastActivityAt);
  });

  it('falls back to updatedAt for sessions saved before the field existed', () => {
    const alpha = withUser(store, 'Alpha');
    store.saveSession(alpha);
    const legacy = withUser(store, 'Legacy');
    delete legacy.lastActivityAt;
    store.saveSession(legacy);

    const listed = store.listSavedSessions();
    expect(listed[0]!.id).toBe(legacy.id);
    expect(listed[0]!.lastActivityAt).toBeUndefined();
    expect(listed[0]!.updatedAt).toBe(listed[0]!.updatedAt);
  });

  it('breaks equal activity stamps deterministically by id', () => {
    const alpha = withUser(store, 'Alpha');
    const beta = withUser(store, 'Beta');
    store.saveSession(alpha);
    store.saveSession(beta);
    const shared = new Date('2026-10-27T00:00:00.000Z').toISOString();
    for (const id of [alpha.id, beta.id]) {
      const file = store.listSessionFiles().find((entry) => entry.id === id)!;
      const parsed = JSON.parse(readFileSync(file.path, 'utf8')) as Record<string, unknown>;
      parsed.lastActivityAt = shared;
      writeFileSync(file.path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    }

    const ids = store.listSavedSessions().map((session) => session.id);
    const ordered = [alpha.id, beta.id].sort((left, right) => left.localeCompare(right));
    expect(ids.filter((id) => id === ordered[0] || id === ordered[1])).toEqual(ordered);
  });

  it('reopening a conversation does not rewrite its file, content changes still do', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const model = new MockLanguageModelV3({ modelId: 'model-a', doStream: async () => Promise.reject(new Error('unused')) });
    controller = new AgentSessionController(runtimeFor(model));
    controller.addEntry({ kind: 'user', text: 'hello' });
    await controller.flushSave();

    const file = store.listSessionFiles().find((entry) => entry.id === controller!.getSnapshot().session.id)!;
    const before = readFileSync(file.path, 'utf8');
    const activityBefore = store.readSessionHeader(file.path, file.id)!.lastActivityAt;

    // Pure navigation: load the same conversation back through openSession.
    const loaded = store.loadSavedSession(file.id)!;
    await controller.openSession(loaded);
    expect(readFileSync(file.path, 'utf8')).toBe(before);

    // Real content: a new message must persist and move the activity stamp.
    controller.addEntry({ kind: 'user', text: 'second' });
    await controller.flushSave();
    const after = readFileSync(file.path, 'utf8');
    expect(after).not.toBe(before);
    expect(store.readSessionHeader(file.path, file.id)!.lastActivityAt! >= (activityBefore ?? '')).toBe(true);
  });
});

describe('session persistence responsiveness', () => {
  it('preserves JSON semantics for provider URLs and binary image data', async () => {
    const original = {
      ...withUser(store, 'image references'),
      conversation: [
        {
          role: 'user' as const,
          content: [
            { type: 'image' as const, image: new URL('https://example.com/fixture.png') },
            { type: 'image' as const, image: Buffer.from([1, 2, 3]) },
          ],
        },
      ],
    };
    const expected = JSON.parse(JSON.stringify(original.conversation));
    await store.saveSessionAsync(original);
    const file = store.listSessionFiles().find((candidate) => candidate.id === original.id)!;
    expect(JSON.parse(readFileSync(file.path, 'utf8')).conversation).toEqual(expected);
  });

  it('orders overlapping saves without replacing newer live content', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const model = new MockLanguageModelV3({ doStream: async () => Promise.reject(new Error('unused')) });
    controller = new AgentSessionController(runtimeFor(model));
    controller.addEntry({ kind: 'user', text: 'first' });
    const first = controller.flushSave();
    controller.addEntry({ kind: 'assistant', text: 'newer content' });
    const second = controller.flushSave();
    await Promise.all([first, second]);
    expect(controller.getSnapshot().session.entries.at(-1)).toMatchObject({ text: 'newer content' });
    const id = controller.getSnapshot().session.id;
    expect(store.loadSavedSession(id)!.entries.at(-1)).toMatchObject({ text: 'newer content' });
    const file = store.listSessionFiles().find((candidate) => candidate.id === id)!;
    const before = readFileSync(file.path, 'utf8');
    await controller.flushSave();
    expect(readFileSync(file.path, 'utf8')).toBe(before);
  });

  it('keeps navigation isolated from an earlier save completing', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const model = new MockLanguageModelV3({ doStream: async () => Promise.reject(new Error('unused')) });
    const next = store.saveSession(withUser(store, 'other session'));
    controller = new AgentSessionController(runtimeFor(model));
    controller.addEntry({ kind: 'user', text: 'pending save' });
    const previousId = controller.getSnapshot().session.id;
    const pending = controller.flushSave();
    await controller.openSession(next);
    await pending;
    await controller.flushSave();
    expect(controller.getSnapshot().session.id).toBe(next.id);
    expect(controller.getSnapshot().session.entries).toEqual(next.entries);
    expect(store.loadSavedSession(previousId)!.entries[0]).toMatchObject({ text: 'pending save' });
  });

  it('reports a failed worker write and retries without a synchronous fallback', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { ensureSessionDirectory, sessionFilePath } = await import('../src/session-paths.js');
    const model = new MockLanguageModelV3({ doStream: async () => Promise.reject(new Error('unused')) });
    controller = new AgentSessionController(runtimeFor(model));
    controller.addEntry({ kind: 'user', text: 'durable after retry' });
    const id = controller.getSnapshot().session.id;
    ensureSessionDirectory(id);
    const path = sessionFilePath(id);
    mkdirSync(path);
    await expect(controller.flushSave()).rejects.toThrow();
    expect(controller.getSnapshot().sessionSaveError).toEqual(expect.any(String));
    rmSync(path, { recursive: true });
    await controller.flushSave();
    expect(controller.getSnapshot().sessionSaveError).toBeNull();
    expect(store.loadSavedSession(id)!.entries[0]).toMatchObject({ text: 'durable after retry' });
  });

  describe.each(['disk', 'spy'] as const)('explicit save failures (%s)', (failure) => {
    it.each(['flush', 'open', 'load', 'new', 'close'] as const)('rejects %s, retains dirty state, and allows retry', async (action) => {
      const { AgentSessionController } = await import('../src/agent-session.js');
      const { ensureSessionDirectory, sessionFilePath } = await import('../src/session-paths.js');
      const writer = await import('../src/session-writer.js');
      const model = new MockLanguageModelV3({ doStream: async () => Promise.reject(new Error('unused')) });
      controller = new AgentSessionController(runtimeFor(model));
      const source = {
        ...withUser(store, 'previous message'),
        conversation: [{ role: 'user' as const, content: 'previous context' }],
        conversationArchive: [{ role: 'assistant' as const, content: 'archived context' }],
      };
      await controller.openSession(source);
      controller.addEntry({ kind: 'user', text: 'unsaved message' });
      controller.setReasoningPreference('high');
      controller.setShowReasoningPreference(false);
      const before = controller.getSnapshot().session;
      // The load path is scope-checked: the destination must carry the
      // controller's workspace scope or loadSavedSession filters it out.
      const next = store.saveSession({ ...withUser(store, 'destination'), workspaceRoot: process.cwd() });
      const navigate = () => {
        switch (action) {
          case 'flush': return controller!.flushSave();
          case 'open': return controller!.openSession(next);
          case 'load': return controller!.loadSession(next.id);
          case 'new': return controller!.createNewSession();
          case 'close': return controller!.close();
        }
      };
      const path = sessionFilePath(source.id);
      const spy = failure === 'spy' ? vi.spyOn(writer, 'writeSessionSnapshot').mockRejectedValue(new Error('fixture disk failure')) : null;
      if (failure === 'disk') {
        ensureSessionDirectory(source.id);
        mkdirSync(path);
      }
      try {
        // Promise.resolve also tests the old synchronous openSession without masking
        // its false success: all explicit boundaries must reject on writer failure.
        await expect(Promise.resolve(navigate())).rejects.toThrow();
        expect(controller.getSnapshot().session).toEqual(before);
        expect(controller.getSnapshot().sessionSaveError).toEqual(expect.any(String));
        // In disk mode the save path is a directory, so a store read cannot run
        // until the fixture is removed; only the spy failure can read back null here.
        if (failure === 'spy') expect(store.loadSavedSession(source.id)).toBeNull();
      } finally {
        spy?.mockRestore();
        if (failure === 'disk') rmSync(path, { recursive: true, force: true });
      }
      // After the blocking directory is gone the failed save must still have
      // persisted nothing before the retry below.
      expect(store.loadSavedSession(source.id)).toBeNull();
      await navigate();
      const saved = store.loadSavedSession(source.id)!;
      expect(saved).toMatchObject({
        entries: before.entries,
        reasoning: 'high',
        showReasoning: false,
        conversation: source.conversation,
        conversationArchive: source.conversationArchive,
      });
      expect(controller.getSnapshot().sessionSaveError).toBeNull();
      if (action === 'open' || action === 'load') expect(controller.getSnapshot().session.id).toBe(next.id);
      else if (action === 'new') expect(controller.getSnapshot().session.id).not.toBe(source.id);
      else expect(controller.getSnapshot().session.id).toBe(source.id);
    });
  });

  it('shares an in-flight close but retries a failed final flush', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const writer = await import('../src/session-writer.js');
    const model = new MockLanguageModelV3({ doStream: async () => Promise.reject(new Error('unused')) });
    controller = new AgentSessionController(runtimeFor(model));
    controller.addEntry({ kind: 'user', text: 'initial shutdown snapshot' });
    const id = controller.getSnapshot().session.id;
    const write = writer.writeSessionSnapshot;
    const spy = vi.spyOn(writer, 'writeSessionSnapshot')
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(new Error('final flush failed'));
    const idle = vi.spyOn(controller, 'waitUntilIdle').mockImplementationOnce(async () => {
      controller!.addEntry({ kind: 'assistant', text: 'settled during shutdown' });
    });
    try {
      const first = controller.close();
      expect(controller.close()).toBe(first);
      await expect(first).rejects.toThrow('final flush failed');
      expect(controller.getSnapshot().sessionSaveError).toBe('final flush failed');
      expect(store.loadSavedSession(id)!.entries).toHaveLength(1);
      const retry = controller.close();
      expect(retry).not.toBe(first);
      await retry;
      expect(controller.close()).toBe(retry);
      expect(controller.getSnapshot().sessionSaveError).toBeNull();
      expect(store.loadSavedSession(id)!.entries.at(-1)).toMatchObject({ text: 'settled during shutdown' });
    } finally {
      idle.mockRestore();
      spy.mockRestore();
    }
  });

  it('handles a timed save rejection and explicitly retries the same dirty snapshot', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const writer = await import('../src/session-writer.js');
    const model = new MockLanguageModelV3({ doStream: async () => Promise.reject(new Error('unused')) });
    controller = new AgentSessionController(runtimeFor(model));
    vi.useFakeTimers();
    const spy = vi.spyOn(writer, 'writeSessionSnapshot').mockRejectedValue(new Error('timed write failed'));
    try {
      controller.addEntry({ kind: 'user', text: 'timed dirty snapshot' });
      await vi.advanceTimersByTimeAsync(400);
      expect(controller.getSnapshot().sessionSaveError).toBe('timed write failed');
      spy.mockRestore();
      vi.useRealTimers();
      await controller.flushSave();
      expect(controller.getSnapshot().sessionSaveError).toBeNull();
      expect(store.loadSavedSession(controller.getSnapshot().session.id)!.entries[0]).toMatchObject({ text: 'timed dirty snapshot' });
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('propagates an in-flight failure to waiting navigation and saves newer content on retry', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const writer = await import('../src/session-writer.js');
    const model = new MockLanguageModelV3({ doStream: async () => Promise.reject(new Error('unused')) });
    const next = store.saveSession(withUser(store, 'destination'));
    controller = new AgentSessionController(runtimeFor(model));
    controller.addEntry({ kind: 'user', text: 'first snapshot' });
    const id = controller.getSnapshot().session.id;
    let fail!: (error: Error) => void;
    const spy = vi.spyOn(writer, 'writeSessionSnapshot').mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    try {
      const first = controller.flushSave();
      controller.addEntry({ kind: 'assistant', text: 'newer dirty content' });
      const opening = Promise.resolve(controller.openSession(next));
      const results = Promise.allSettled([first, opening]);
      expect(controller.getSnapshot().session.id).toBe(id);
      fail(new Error('pending write failed'));
      expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
      expect(controller.getSnapshot().session.id).toBe(id);
      expect(controller.getSnapshot().session.entries.at(-1)).toMatchObject({ text: 'newer dirty content' });
      expect(controller.getSnapshot().sessionSaveError).toBe('pending write failed');
      spy.mockRestore();
      await controller.openSession(next);
      expect(store.loadSavedSession(id)!.entries.at(-1)).toMatchObject({ text: 'newer dirty content' });
      expect(controller.getSnapshot().session.id).toBe(next.id);
    } finally {
      // Settle the writer even if a pre-fix navigation assertion fails.
      fail(new Error('fixture cleanup'));
      spy.mockRestore();
    }
  });

  it('never serializes the whole transcript on the controller thread', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const model = new MockLanguageModelV3({ doStream: async () => Promise.reject(new Error('unused')) });
    controller = new AgentSessionController(runtimeFor(model));
    controller.addEntry({ kind: 'user', text: 'large transcript' });
    controller.addEntry({ kind: 'assistant', text: 'x'.repeat(2_000_000) });
    const stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
      if (value && typeof value === 'object' && Array.isArray(value.entries)) throw new Error('Transcript serialized on host thread');
      return stringify(value, ...args);
    });
    try {
      await controller.flushSave();
      expect(controller.getSnapshot().sessionSaveError).toBeNull();
      const saved = store.loadSavedSession(controller.getSnapshot().session.id)!;
      expect(saved.entries.at(-1)).toMatchObject({ text: 'x'.repeat(2_000_000) });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a chat without a message is not a store file', () => {
  it('creation and project selection write nothing until the first message lands', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const model = new MockLanguageModelV3({ modelId: 'model-a', doStream: async () => Promise.reject(new Error('unused')) });
    controller = new AgentSessionController(runtimeFor(model));
    const id = controller.getSnapshot().session.id;

    // Picking a project on the fresh chat must not create the file either.
    controller.selectProject(null, id);
    await controller.createNewSession(null);
    expect(store.listSessionFiles()).toHaveLength(0);
    expect(store.listSavedSessions()).toEqual([]);

    // The first message is what brings the chat into existence.
    controller.addEntry({ kind: 'user', text: 'first' });
    await controller.flushSave();
    const files = store.listSessionFiles();
    expect(files).toHaveLength(1);
    expect(store.readSessionHeader(files[0]!.path, files[0]!.id)).toMatchObject({ hasUserMessage: true });
  });
});

describe('web catalog lists only chats the store knows', () => {
  const fakeClient = (session: ReturnType<Store['createSession']>, busy = false) =>
    ({
      getSnapshot: () => ({ session, busy, runningTurnId: null, queuedMessageCount: 0 }),
      subscribe: () => () => {},
      close: async () => {},
      isBusy: busy,
      runtime: { providerId: session.providerId, modelId: session.modelId },
      listSessions: async () => [],
    }) as unknown as AgentSessionClient;

  it('leaves a live but unsaved chat out of the list, across gets that touch connections', async () => {
    const bornAt = '2026-10-26T10:00:00.000Z';
    const defaultSession = { ...store.createSession('fixture', 'model-a'), createdAt: bornAt };
    const freshSession = { ...store.createSession('fixture', 'model-a'), createdAt: bornAt };

    const { connectDaemonSession } = await import('../src/daemon-client.js');
    vi.mocked(connectDaemonSession).mockResolvedValue(fakeClient(freshSession));

    const { WebSessions } = await import('../src/web/sessions.js');
    const web = new WebSessions(fakeClient(defaultSession), dataDir);
    try {
      await web.create(null);
      const before = await web.list();
      await new Promise((finish) => setTimeout(finish, 25));
      await web.get(freshSession.id);
      const after = await web.list();

      // No store record, no row: a draft chat is not part of the catalog.
      expect(after.map((entry) => entry.id)).toEqual([]);
      expect(after.map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
    } finally {
      await web.close();
    }
  });

  it('overlays live title and running state onto a store-listed chat without reordering it', async () => {
    const saved = store.saveSession({ ...withUser(store, 'Saved title'), lastActivityAt: '2026-10-26T09:00:00.000Z' });
    const summary = store.listSavedSessions()[0]!;
    const live = { ...store.loadSavedSession(saved.id)!, title: 'Live title' };
    const listSessions = vi.fn(async () => [summary]);

    const { WebSessions } = await import('../src/web/sessions.js');
    // The default client is the live connection to the saved chat: its own
    // snapshot carries the fresher title and the running flag.
    const web = new WebSessions({ ...fakeClient(live, true), listSessions } as unknown as AgentSessionClient, dataDir);
    try {
      const listed = await web.list();

      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: saved.id,
        title: 'Live title',
        running: true,
        lastActivityAt: '2026-10-26T09:00:00.000Z',
      });
    } finally {
      await web.close();
    }
  });
});
