import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEnvironment, AgentSessionController } from '../src/agent-session.js';
import type { SessionEntry } from '../src/session-store.js';
import type { ModelMessage } from 'ai';
import { ToolRegistry } from '../src/tools/registry.js';

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

type StreamStep = LanguageModelV3StreamPart | { pause: number };

function delayedStream(
  steps: StreamStep[],
  finishReason: 'stop' | 'tool-calls' | 'length' = 'stop',
  inputTokens = 100,
): LanguageModelV3StreamResult {
  return {
    stream: new ReadableStream({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        for (const step of steps) {
          if ('pause' in step) await delay(step.pause);
          else controller.enqueue(step);
        }
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: finishReason, raw: finishReason },
          usage: { ...usage, inputTokens: { ...usage.inputTokens, total: inputTokens, noCache: inputTokens } },
        });
        controller.close();
      },
    }),
  };
}

function runtimeFor(model: MockLanguageModelV3, registry = new ToolRegistry()): AgentEnvironment {
  return {
    model,
    workspaceRoot: process.cwd(),
    modelName: 'Local streaming fixture',
    providerId: 'fixture',
    modelId: 'fixture',
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
    registry,
    selectModel: async () => {},
    close: async () => {},
  };
}

function titleResponse() {
  return {
    content: [{ type: 'text' as const, text: '{"title":"Fixture greeting"}' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage,
    warnings: [],
  };
}

let dataDir: string;
let previousDataDir: string | undefined;
let session: AgentSessionController | undefined;

beforeEach(() => {
  previousDataDir = process.env.OPENBUTLER_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'openbutler-session-stream-'));
  process.env.OPENBUTLER_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  if (previousDataDir === undefined) delete process.env.OPENBUTLER_DATA_DIR;
  else process.env.OPENBUTLER_DATA_DIR = previousDataDir;
  if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith('openbutler-session-stream-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function fixtureText(text: string, finishReason: 'stop' | 'length' = 'stop', inputTokens = 100) {
  return delayedStream(
    [
      { type: 'text-start', id: 'fixture' },
      { type: 'text-delta', id: 'fixture', delta: text },
      { type: 'text-end', id: 'fixture' },
    ],
    finishReason,
    inputTokens,
  );
}

describe('owner replies and safe steering', () => {
  it('finishes replies and accepts the next message while the first title is still being generated', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    let complete!: (value: ReturnType<typeof titleResponse>) => void;
    const pending = new Promise<ReturnType<typeof titleResponse>>((resolve) => {
      complete = resolve;
    });
    const generate = vi.fn<MockLanguageModelV3['doGenerate']>(() => pending);
    const model = new MockLanguageModelV3({ doGenerate: generate, doStream: async () => fixtureText('Completed answer') });
    session = new AgentSessionController(runtimeFor(model));
    await session.sendMessage({ text: 'First message', images: [] });
    await session.waitUntilIdle(1000);
    expect(session.getSnapshot().busy).toBe(false);
    expect(session.getSnapshot().session.entries.find((entry) => entry.kind === 'user')?.turnOutcome).toBe('completed');
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    await session.sendMessage({ text: 'Next message', images: [] });
    await session.waitUntilIdle(1000);
    expect(session.getSnapshot().session.entries.filter((entry) => entry.kind === 'user')).toHaveLength(2);
    complete(titleResponse());
    await vi.waitFor(() => expect(session!.getSnapshot().session.title).toBe('Fixture greeting'));
  });

  it('carries the effort this chat owns into every model step', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const runtime = runtimeFor(
      new MockLanguageModelV3({
        doGenerate: async () => titleResponse(),
        doStream: async () => fixtureText('Chosen effort'),
      }),
    );
    runtime.reasoningVariants = [
      { id: 'default', label: 'Default', providerOptions: {} },
      { id: 'low', label: 'Low', providerOptions: {} },
      { id: 'medium', label: 'Medium', providerOptions: {} },
      { id: 'high', label: 'High', providerOptions: {} },
    ];
    const seen: string[] = [];
    runtime.getReasoningProviderOptions = (variantId: string) => {
      seen.push(variantId);
      return {};
    };
    session = new AgentSessionController(runtime);
    // The chat owns its effort: a message body carries none any more, so the
    // only way an effort reaches a request is the chat's own record.
    session.setReasoningPreference('high');
    await session.sendMessage({ text: 'Reason hard', images: [] });
    await session.waitUntilIdle(1000);
    expect(seen[0]).toBe('high');
    expect(seen).toContain('high');
  });

  it('keeps generating the title across a session switch and applies it to the original session', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    let complete!: (value: ReturnType<typeof titleResponse>) => void;
    const pending = new Promise<ReturnType<typeof titleResponse>>((resolve) => {
      complete = resolve;
    });
    const generate = vi.fn<MockLanguageModelV3['doGenerate']>(() => pending);
    session = new AgentSessionController(
      runtimeFor(new MockLanguageModelV3({ doGenerate: generate, doStream: async () => fixtureText('Done') })),
    );
    await session.sendMessage({ text: 'First message', images: [] });
    await session.waitUntilIdle(1000);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const signal = generate.mock.calls[0]![0]?.abortSignal;
    const originalId = session.getSnapshot().session.id;
    await session.createNewSession();
    const next = session.getSnapshot().session;
    // The generation belongs to the original session: a switch must not cancel it.
    expect(signal?.aborted).toBe(false);
    complete(titleResponse());
    await vi.waitFor(() => expect(loadSavedSession(originalId)?.title).toBe('Fixture greeting'), { timeout: 5_000 });
    expect(session.getSnapshot().session.id).toBe(next.id);
    expect(session.getSnapshot().session.title).toBe('New session');
  });

  it('starts the custodian at its reserved id with an identity-bound budget and refuses to replace it', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { compactionContextWindowTokens, loadSavedSession } = await import('../src/session-store.js');
    const { CUSTODIAN_SESSION_ID } = await import('../src/session-paths.js');
    session = new AgentSessionController(runtimeFor(new MockLanguageModelV3({ doStream: async () => fixtureText('Done') })));
    const previousId = session.getSnapshot().session.id;

    await session.startCustodianSession();
    expect(session.getSnapshot().session.id).toBe(CUSTODIAN_SESSION_ID);
    expect(session.getSnapshot().session.id).not.toBe(previousId);
    const stored = loadSavedSession(CUSTODIAN_SESSION_ID);
    expect(stored?.id).toBe(CUSTODIAN_SESSION_ID);
    expect(stored?.entries).toEqual([]);
    // The budget follows the reserved id rather than the record, so an ordinary
    // chat cannot inherit a cap and no saved field can re-tune compaction.
    expect(compactionContextWindowTokens(CUSTODIAN_SESSION_ID, 1_048_576, 100_000)).toBe(200_000);
    expect(compactionContextWindowTokens(previousId, 1_048_576, 100_000)).toBe(1_048_576);
    await expect(session.createNewSession()).rejects.toThrow('The custodian session is fixed; new chats open in the chat layer.');

    // The identity is the reserved id, so a restart restores the same record with the
    // same budget and cannot quietly turn the custodian back into an ordinary chat.
    const reloaded = new AgentSessionController(runtimeFor(new MockLanguageModelV3({ doStream: async () => fixtureText('Done') })));
    try {
      await reloaded.loadSession(CUSTODIAN_SESSION_ID);
      expect(reloaded.getSnapshot().session.id).toBe(CUSTODIAN_SESSION_ID);
      await expect(reloaded.createNewSession()).rejects.toThrow('The custodian session is fixed; new chats open in the chat layer.');
    } finally {
      await reloaded.close();
    }
    expect(session.getSnapshot().session.id).toBe(CUSTODIAN_SESSION_ID);
  });

  it('closes without waiting for a stalled title request and still lands the title', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    let complete!: (value: ReturnType<typeof titleResponse>) => void;
    const pending = new Promise<ReturnType<typeof titleResponse>>((resolve) => {
      complete = resolve;
    });
    const generate = vi.fn<MockLanguageModelV3['doGenerate']>(() => pending);
    session = new AgentSessionController(
      runtimeFor(new MockLanguageModelV3({ doGenerate: generate, doStream: async () => fixtureText('Done') })),
    );
    await session.sendMessage({ text: 'First message', images: [] });
    await session.waitUntilIdle(1000);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const sessionId = session.getSnapshot().session.id;
    await session.close();
    // Closing must not wait for the stalled request, and must not cancel it either.
    expect(generate.mock.calls[0]![0]?.abortSignal?.aborted).toBe(false);
    complete(titleResponse());
    await vi.waitFor(() => expect(loadSavedSession(sessionId)?.title).toBe('Fixture greeting'), { timeout: 5_000 });
  });

  it('keeps the session on New session until the title model answers', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    let complete!: (value: ReturnType<typeof titleResponse>) => void;
    const pending = new Promise<ReturnType<typeof titleResponse>>((resolve) => {
      complete = resolve;
    });
    const generate = vi.fn<MockLanguageModelV3['doGenerate']>(() => pending);
    session = new AgentSessionController(
      runtimeFor(new MockLanguageModelV3({ doGenerate: generate, doStream: async () => fixtureText('Done') })),
    );
    // A one-word first message used to become "<word> chat" before any model answered.
    await session.sendMessage({ text: 'hey', images: [] });
    await session.waitUntilIdle(1000);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const sessionId = session.getSnapshot().session.id;
    expect(session.getSnapshot().session.title).toBe('New session');
    await vi.waitFor(() => expect(loadSavedSession(sessionId)?.title).toBe('New session'), { timeout: 5_000 });
    complete(titleResponse());
    await vi.waitFor(() => expect(session!.getSnapshot().session.title).toBe('Fixture greeting'));
  });

  it('titles the chat from the user messages and the first assistant reply', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const generate = vi.fn<MockLanguageModelV3['doGenerate']>(async () => titleResponse());
    session = new AgentSessionController(
      runtimeFor(new MockLanguageModelV3({ doGenerate: generate, doStream: async () => fixtureText('Completed answer') })),
    );
    await session.sendMessage({ text: 'First message', images: [] });
    await session.waitUntilIdle(1000);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const prompt = JSON.stringify(generate.mock.calls[0]![0]?.prompt ?? null);
    expect(prompt).toContain('First message');
    expect(prompt).toContain('Completed answer');
    await vi.waitFor(() => expect(session!.getSnapshot().session.title).toBe('Fixture greeting'));
  });

  it('starts the title from the first assistant reply even when the run is aborted', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    let complete!: (value: ReturnType<typeof titleResponse>) => void;
    const pending = new Promise<ReturnType<typeof titleResponse>>((resolve) => {
      complete = resolve;
    });
    const generate = vi.fn<MockLanguageModelV3['doGenerate']>(() => pending);
    session = new AgentSessionController(
      runtimeFor(
        new MockLanguageModelV3({
          doGenerate: generate,
          // A provider's HTTP stream dies with an AbortError when the request is
          // aborted; the SDK only re-checks the signal after each read returns,
          // so a stall that ignores the signal would hang the run forever.
          doStream: async ({ abortSignal }) => ({
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({ type: 'text-start', id: 'fixture' });
                controller.enqueue({ type: 'text-delta', id: 'fixture', delta: 'Partial answer' });
                controller.enqueue({ type: 'text-end', id: 'fixture' });
                // No finish part: the run stays open until the test aborts it.
                abortSignal?.addEventListener('abort', () => {
                  controller.error(abortSignal.reason ?? new DOMException('Aborted', 'AbortError'));
                });
              },
            }),
          }),
        }),
      ),
    );
    void session.sendMessage({ text: 'First message', images: [] }).catch(() => {});
    await vi.waitFor(() =>
      expect(session!.getSnapshot().streamingAssistantEntry).toMatchObject({ text: expect.stringContaining('Partial answer') }),
    );
    session.stop();
    await session.waitUntilIdle(1000);
    // The aborted run still produced the first assistant reply, so the generation starts.
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    complete(titleResponse());
    await vi.waitFor(() => expect(session!.getSnapshot().session.title).toBe('Fixture greeting'));
  });

  it('logs a failed title generation instead of swallowing it', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { existsSync, readFileSync } = await import('node:fs');
    const generate = vi.fn<MockLanguageModelV3['doGenerate']>(async () => {
      throw new Error('title model unavailable');
    });
    session = new AgentSessionController(
      runtimeFor(new MockLanguageModelV3({ doGenerate: generate, doStream: async () => fixtureText('Done') })),
    );
    await session.sendMessage({ text: 'First message', images: [] });
    await session.waitUntilIdle(1000);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const logPath = join(dataDir, 'logs', 'openbutler.log');
    await vi.waitFor(() => {
      expect(existsSync(logPath)).toBe(true);
      const log = readFileSync(logPath, 'utf8');
      expect(log).toContain('session.title.failed');
      expect(log).toContain('title model unavailable');
    });
    expect(session.getSnapshot().session.title).toBe('New session');
  });

  it('pins the title generation timeout at 300 seconds', async () => {
    const { TITLE_GENERATION_TIMEOUT_MS } = await import('../src/agent-session.js');
    expect(TITLE_GENERATION_TIMEOUT_MS).toBe(300_000);
  });

  it('queues web messages by default and promotes only the selected message into the active turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        started = true;
        await gate;
        return { message: 'Evidence' };
      },
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream([{ type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        )
        .mockImplementationOnce(async () => fixtureText('Original task completed with the correction.'))
        .mockImplementationOnce(async () => fixtureText('Queued task completed.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    // Web keeps the explicit steer button: queued until promoted.
    const communication = { source: 'web' as const, replyTo: { channel: 'terminal' as const } };
    const first = session.sendMessage({ text: 'Original task.', images: [], communication });
    await vi.waitFor(() => expect(started).toBe(true));
    const waiting = session.sendMessage({ text: 'Later independent task.', images: [], communication });
    const steering = session.sendMessage({ text: 'Correct the current task.', images: [], communication });
    const removed = session.sendMessage({ text: 'Removed task.', images: [], communication });
    const pending = session.getSnapshot().queuedMessages;
    expect(pending.every((message) => message.steering === false)).toBe(true);
    session.manageQueuedMessage(pending[1]!.id!, 'steer', session.getSnapshot().session.id);
    session.manageQueuedMessage(pending[2]!.id!, 'remove', session.getSnapshot().session.id);
    await removed;
    release();
    await Promise.all([first, waiting, steering]);
    expect(model.doStreamCalls).toHaveLength(3);
    const activePrompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(activePrompt).toContain('Correct the current task.');
    expect(activePrompt).not.toContain('Later independent task.');
    expect(JSON.stringify(model.doStreamCalls)).not.toContain('Removed task.');
    const nextPrompt = model.doStreamCalls[2]!.prompt;
    expect(JSON.stringify(nextPrompt.at(-1))).toContain('Later independent task.');
    expect(JSON.stringify(nextPrompt.at(-1))).not.toContain('follow-up steering');
    expect(JSON.stringify(nextPrompt)).toContain('Original task completed with the correction.');
    const entries = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'user');
    expect(entries.map((entry) => entry.text)).toEqual(['Original task.', 'Correct the current task.', 'Later independent task.']);
    expect(entries[1]!.turnId).toBe(entries[0]!.turnId);
    expect(entries[2]!.turnId).not.toBe(entries[0]!.turnId);
    expect(() => session!.manageQueuedMessage('missing', 'steer', session!.getSnapshot().session.id)).toThrow('no running task');
  });

  it('admits an explicitly steered message even when the current model request finishes without tools', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => {
          started = true;
          await gate;
          return fixtureText('Initial response.');
        })
        .mockImplementationOnce(async () => fixtureText('Updated response.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model), undefined, { sessionWorkspaceRoot: null });
    const communication = { source: 'terminal' as const, replyTo: { channel: 'terminal' as const } };
    const first = session.sendMessage({ text: 'Original request', images: [], communication });
    await vi.waitFor(() => expect(started).toBe(true));
    const second = session.sendMessage({ text: 'Change the current request', images: [], communication });
    const queued = session.getSnapshot().queuedMessages[0]!;
    session.manageQueuedMessage(queued.id!, 'steer', session.getSnapshot().session.id);
    release();
    await Promise.all([first, second]);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('follow-up steering for the task already in progress');
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('Change the current request');
    const users = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'user');
    expect(users).toHaveLength(2);
    expect(users[1]!.turnId).toBe(users[0]!.turnId);
    expect(session.getSnapshot().queuedMessageCount).toBe(0);
  });

  it('steers an owner correction into a run that a wake started', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        started = true;
        await gate;
        return { message: 'Evidence' };
      },
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream([{ type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        )
        .mockImplementationOnce(async () => fixtureText('Handled with the correction.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    // A workspace-bound controller, like the chats that carry a project.
    session = new AgentSessionController(runtimeFor(model, registry));
    // The run was started by a wake. A host signal carries no reply route of
    // its own, and where that run's answer ends is that run's business.
    const first = session.sendMessage({ text: 'Read the inbox.', images: [], communication: { source: 'inbox' } });
    await vi.waitFor(() => expect(started).toBe(true));
    // The owner writes from the web, where every message carries the terminal route.
    const correction = session.sendMessage({
      text: 'Correct the current task.',
      images: [],
      communication: { source: 'web', replyTo: { channel: 'terminal' } },
    });
    const queued = session.getSnapshot().queuedMessages[0]!;
    expect(queued.steering).toBe(false);
    expect(() => session!.manageQueuedMessage(queued.id!, 'steer', session!.getSnapshot().session.id)).not.toThrow();
    release();
    await Promise.all([first, correction]);
    expect(model.doStreamCalls).toHaveLength(2);
    const prompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(prompt).toContain('Correct the current task.');
    expect(prompt).toContain('follow-up steering for the task already in progress');
    const users = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'user');
    expect(users).toHaveLength(2);
    expect(users[1]!.turnId).toBe(users[0]!.turnId);
  });

  it('admits a host signal into a workspace-bound run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        started = true;
        await gate;
        return { message: 'Evidence' };
      },
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream([{ type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        )
        .mockImplementationOnce(async () => fixtureText('Handled the signal.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    const first = session.sendMessage({
      text: 'Initial task',
      images: [],
      communication: { source: 'web', replyTo: { channel: 'terminal' } },
    });
    await vi.waitFor(() => expect(started).toBe(true));
    // A host signal steers the live run without waiting for the next turn.
    const signal = session.sendMessage({ text: 'TEAM_SIGNAL', images: [], communication: { source: 'team' } });
    release();
    await Promise.all([first, signal]);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('TEAM_SIGNAL');
  });

  it.each(['terminal', 'web'] as const)(
    'steers %s owner corrections into workspace-bound runs after a parallel tool batch',
    async (source) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      const registry = new ToolRegistry();
      registry.register({
        providerId: 'host',
        name: 'inspect',
        description: 'Fixture',
        inputSchema: { type: 'object', properties: {} },
        effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
        autoApprove: () => true,
        execute: async () => {
          started += 1;
          await gate;
          return { message: 'Tool batch completed' };
        },
      });
      const model = new MockLanguageModelV3({
        doGenerate: async () => titleResponse(),
        doStream: vi
          .fn()
          .mockImplementationOnce(async () =>
            delayedStream(
              [
                { type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' },
                { type: 'tool-call', toolCallId: 'two', toolName: 'inspect', input: '{}' },
              ],
              'tool-calls',
            ),
          )
          .mockImplementationOnce(async () => fixtureText('Revised the running task.')),
      });
      const { AgentSessionController } = await import('../src/agent-session.js');
      // Unlike a custodian chat, a workspace controller has a non-null scope.
      session = new AgentSessionController(runtimeFor(model, registry));
      const communication = { source, replyTo: { channel: 'terminal' as const } };
      const first = session.sendMessage({ text: 'Inspect the project.', images: [], communication });
      await vi.waitFor(() => expect(started).toBeGreaterThan(0));
      const second = session.sendMessage({ text: 'Steer: inspect only, do not edit.', images: [], communication });
      const id = session.getSnapshot().queuedMessages[0]!.id!;
      session.manageQueuedMessage(id, 'steer', session.getSnapshot().session.id);
      release();
      await Promise.all([first, second]);
      expect(started).toBe(2);
      expect(model.doStreamCalls).toHaveLength(2);
      const prompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
      expect(prompt).toContain('Steer: inspect only, do not edit.');
      expect(prompt).toContain('follow-up steering for the task already in progress');
      const users = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'user');
      expect(users[1]!.turnId).toBe(users[0]!.turnId);
    },
  );

  it('does not let an incompatible notification block a later valid owner steer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        started = true;
        await gate;
        return { message: 'Evidence' };
      },
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream([{ type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        )
        .mockImplementationOnce(async () => fixtureText('Revised first task.'))
        .mockImplementationOnce(async () => fixtureText('Handled notification.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    const communication = { source: 'terminal' as const, replyTo: { channel: 'terminal' as const } };
    const first = session.sendMessage({ text: 'Initial task', images: [], communication });
    await vi.waitFor(() => expect(started).toBe(true));
    const notification = session.sendEvent({
      text: 'UNRELATED_NOTIFICATION',
      images: [],
      communication: { source: 'inbox' },
      // A foreign project is what makes this notification incompatible; an
      // effort difference alone never does (the live run governs effort).
      projectContext: { id: 'project-other', name: 'Other', folders: [] },
    });
    const correction = session.sendMessage({ text: 'OWNER_CORRECTION', images: [], communication });
    const owner = session.getSnapshot().queuedMessages.find((message) => message.text === 'OWNER_CORRECTION')!;
    session.manageQueuedMessage(owner.id!, 'steer', session.getSnapshot().session.id);
    release();
    await Promise.all([first, notification, correction]);
    expect(model.doStreamCalls).toHaveLength(3);
    const active = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(active).toContain('OWNER_CORRECTION');
    expect(active).not.toContain('UNRELATED_NOTIFICATION');
    expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).toContain('UNRELATED_NOTIFICATION');
  });

  it('admits a steer whose effort differs from the running turn but refuses a foreign project', async () => {
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        started = true;
        await gate;
        return { message: 'Evidence' };
      },
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream([{ type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        )
        .mockImplementationOnce(async () => fixtureText('Handled with the new effort.'))
        .mockImplementationOnce(async () => fixtureText('Handled in the other project.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    // Web: messages queue until the steer button, so both the promotion path
    // and the foreign-project refusal stay exercisable here.
    const communication = { source: 'web' as const, replyTo: { channel: 'terminal' as const } };
    const first = session.sendMessage({ text: 'Initial task', images: [], communication });
    await vi.waitFor(() => expect(started).toBe(true));

    // The running turn governs the live effort, so a queued message carrying another
    // effort must still be admitted — the owner changed the setting, newest wins.
    const correction = session.sendMessage({ text: 'Narrow it to the failing case.', images: [], communication });
    const queued = session.getSnapshot().queuedMessages[0]!;
    expect(queued.steering).toBe(false);
    session.manageQueuedMessage(queued.id!, 'steer', session.getSnapshot().session.id);
    expect(session.getSnapshot().queuedMessages[0]!.steering).toBe(true);

    // A different project is a real incompatibility: it stays queued.
    const foreign = session.sendMessage({
      text: 'Start something else.',
      images: [],
      communication,
      projectContext: { id: 'project-x', name: 'Other', folders: [] },
    });
    const foreignQueued = session.getSnapshot().queuedMessages.find((message) => message.text === 'Start something else.')!;
    expect(() => session!.manageQueuedMessage(foreignQueued.id!, 'steer', session!.getSnapshot().session.id)).toThrow('different project');
    expect(session.getSnapshot().queuedMessages.some((message) => message.text === 'Start something else.' && !message.steering)).toBe(
      true,
    );

    release();
    await Promise.all([first, correction, foreign]);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('Narrow it to the failing case.');
    expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).toContain('Start something else.');
  });

  it('steers actual owner text after tool results, shares one reply, and excludes tool traces', async () => {
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        started = true;
        await gate;
        return { message: 'private tool trace' };
      },
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream(
            [
              { type: 'text-start', id: 'before' },
              { type: 'text-delta', id: 'before', delta: 'Looking into it.' },
              { type: 'text-end', id: 'before' },
              { type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' },
            ],
            'tool-calls',
          ),
        )
        .mockImplementationOnce(async () => fixtureText('Your new request has been taken into account.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    const communication = { source: 'telegram' as const, replyTo: { channel: 'telegram' as const, chatId: '42' } };
    const first = session.sendMessage({ text: 'Review it.', images: [], eventId: 'first', communication });
    await vi.waitFor(() => expect(started).toBe(true));
    const second = session.sendMessage({ text: 'Do not delete, only read.', images: [], eventId: 'second', communication });
    const queued = session.getSnapshot().queuedMessages[0]!;
    expect(queued.steering).toBe(false);
    session.manageQueuedMessage(queued.id!, 'steer', session.getSnapshot().session.id);
    expect(session.getSnapshot().queuedMessages[0]!.steering).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(model.doStreamCalls).toHaveLength(2);
    const prompt = model.doStreamCalls[1]!.prompt;
    const steerIndex = prompt.findIndex(
      (message) => message.role === 'user' && JSON.stringify(message.content).includes('Do not delete, only read.'),
    );
    expect(steerIndex).toBeGreaterThan(0);
    expect(prompt[steerIndex - 1]!.role).toBe('tool');
    expect(
      prompt.filter((message) => message.role === 'user' && JSON.stringify(message.content).includes('Do not delete, only read.')),
    ).toHaveLength(1);
    expect(JSON.stringify(prompt)).toContain('[Host context: owner message via Telegram]');
    expect(JSON.stringify(prompt)).toContain('reply through send_message_to_owner');
    expect(JSON.stringify(prompt)).toContain('follow-up steering for the task already in progress');
    expect(JSON.stringify(prompt)).toContain('then continue the unfinished work');
    expect(JSON.stringify(prompt)).not.toContain('telegramAvailable');
    const userEntries = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'user');
    expect(userEntries).toHaveLength(2);
    expect(userEntries[1]!.turnId).toBe(userEntries[0]!.turnId);
    expect(userEntries[0]!.turnOutcome).toBe('completed');
    expect(userEntries[0]!.turnEndedAt).toBeGreaterThanOrEqual(userEntries[0]!.at!);
    expect(userEntries[1]!.turnOutcome).toBeUndefined();
    expect(session.takeEventRunResult('first')).toEqual({
      error: null,
      outputs: [
        { kind: 'assistant', text: 'Looking into it.' },
        { kind: 'assistant', text: 'Your new request has been taken into account.' },
      ],
    });
    expect(session.takeEventRunResult('second')).toEqual({ error: null, outputs: [], replyHandledByEventId: 'first' });
  });

  it.each(['terminal', 'web'] as const)('drains explicitly steered %s messages in the same gap', async (source) => {
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        started = true;
        await gate;
        return { message: 'Tool completed' };
      },
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream(
            [
              { type: 'text-start', id: 'before' },
              { type: 'text-delta', id: 'before', delta: 'Looking into it.' },
              { type: 'text-end', id: 'before' },
              { type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' },
            ],
            'tool-calls',
          ),
        )
        .mockImplementationOnce(async () => fixtureText('All three requests have been taken into account.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    const terminal = { source, replyTo: { channel: 'terminal' as const } };
    const first = session.sendMessage({ text: 'First task.', images: [], communication: terminal });
    await vi.waitFor(() => expect(started).toBe(true));
    const second = session.sendMessage({ text: 'Second note alpha.', images: [], communication: terminal });
    const third = session.sendMessage({ text: 'Third note beta.', images: [], communication: terminal });
    const fourth = session.sendMessage({ text: 'Fourth note gamma.', images: [], communication: terminal });
    for (const queued of session.getSnapshot().queuedMessages) {
      session.manageQueuedMessage(queued.id!, 'steer', session.getSnapshot().session.id);
    }
    release();
    await Promise.all([first, second, third, fourth]);
    // One initial step plus a single steered step carrying the whole burst.
    expect(model.doStreamCalls).toHaveLength(2);
    const prompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(prompt).toContain('Second note alpha.');
    expect(prompt).toContain('Third note beta.');
    expect(prompt).toContain('Fourth note gamma.');
    expect(prompt).toContain(`[Host context: owner message via ${source}]`);
    expect(prompt).toContain('follow-up steering for the task already in progress');
    expect(prompt.indexOf('Second note alpha.')).toBeLessThan(prompt.indexOf('Third note beta.'));
    expect(prompt.indexOf('Third note beta.')).toBeLessThan(prompt.indexOf('Fourth note gamma.'));
    expect(session.getSnapshot().queuedMessageCount).toBe(0);
  });

  it('finalizes an empty direct reply once without repeating tools', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => delayedStream([]))
        .mockImplementationOnce(async () => fixtureText('Hello!')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model), undefined, { sessionWorkspaceRoot: null });
    await session.sendMessage({
      text: 'hello',
      images: [],
      eventId: 'hello',
      communication: { source: 'telegram', replyTo: { channel: 'telegram', chatId: '42' } },
    });
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[1]!.tools ?? []).toHaveLength(0);
    expect(session.takeEventRunResult('hello')).toEqual({ error: null, outputs: [{ kind: 'assistant', text: 'Hello!' }] });
  });

  it('lets a follow-up with another reply route join the live run and answers on the run route', async () => {
    let next: Promise<void> | undefined;
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        next = session!.sendMessage({
          text: 'Terminal followup',
          images: [],
          eventId: 'terminal',
          communication: { source: 'terminal', replyTo: { channel: 'terminal' } },
        });
        session!.manageQueuedMessage(session!.getSnapshot().queuedMessages[0]!.id!, 'steer', session!.getSnapshot().session.id);
        return { message: 'Tool completed' };
      },
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream([{ type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        )
        .mockImplementationOnce(async () => fixtureText('Telegram answer'))
        .mockImplementationOnce(async () => fixtureText('Terminal answer')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    await session.sendMessage({
      text: 'Telegram request',
      images: [],
      eventId: 'telegram',
      communication: { source: 'telegram', replyTo: { channel: 'telegram', chatId: '42' } },
    });
    await next;
    // The route of the follow-up does not keep it out of the live run: the run
    // answers once, on the route the run itself carries.
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('Terminal followup');
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('follow-up steering for the task already in progress');
    expect(session.takeEventRunResult('telegram')?.outputs).toEqual([{ kind: 'assistant', text: 'Telegram answer' }]);
  });

  it('preserves every assistant segment across tools without including their output or reasoning', async () => {
    const answers = ['Looking into it.', 'I found something.', 'Long answer '.repeat(600), 'Yes, that is how it is.'];
    let call = 0;
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ message: 'Internal tool output' }),
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () => {
        const index = call++;
        return delayedStream(
          [
            { type: 'reasoning-start', id: `r${index}` },
            { type: 'reasoning-delta', id: `r${index}`, delta: 'Private reasoning' },
            { type: 'reasoning-end', id: `r${index}` },
            { type: 'text-start', id: `t${index}` },
            { type: 'text-delta', id: `t${index}`, delta: answers[index]! },
            { type: 'text-end', id: `t${index}` },
            ...(index < 3 ? [{ type: 'tool-call' as const, toolCallId: `call${index}`, toolName: 'inspect', input: '{}' }] : []),
          ],
          index < 3 ? 'tool-calls' : 'stop',
        );
      },
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    await session.sendMessage({
      text: 'Inspect',
      images: [],
      eventId: 'all',
      communication: { source: 'telegram', replyTo: { channel: 'telegram', chatId: '42' } },
    });
    expect(session.takeEventRunResult('all')?.outputs.map((output) => output.text)).toEqual(answers);
  });

  it('reports a missing answer after one finalization instead of retrying indefinitely', async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => titleResponse(), doStream: async () => delayedStream([]) });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model));
    await session.sendMessage({ text: 'Hello', images: [], communication: { source: 'terminal', replyTo: { channel: 'terminal' } } });
    expect(model.doStreamCalls).toHaveLength(2);
    expect(session.getLastRunError()).toContain('without a user-facing answer');
    expect(session.getSnapshot().session.entries.find((entry) => entry.kind === 'user')?.turnOutcome).toBe('failed');
  });
});

describe('restored session model identity', () => {
  it('keeps the saved selection on the chat and leaves the shared runtime alone', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    const runtime = runtimeFor(
      new MockLanguageModelV3({
        doGenerate: async () => titleResponse(),
        doStream: async () => fixtureText('Original answer'),
      }),
    );
    runtime.restoreModel = vi.fn(async (providerId, modelId) => {
      runtime.providerId = providerId;
      runtime.modelId = modelId;
    });
    session = new AgentSessionController(runtime);
    await session.sendMessage({ text: 'Original task', images: [] });
    await session.flushSave();
    const id = session.getSnapshot().session.id;
    runtime.providerId = 'different';
    runtime.modelId = 'default-model';
    await session.loadSession(id);
    await session.flushSave();
    expect(loadSavedSession(id, runtime.workspaceRoot)?.modelId).toBe('fixture');
    await session.restoreSessionModel();
    // The chat runs with the model it saved...
    expect(session.getSnapshot().session.modelId).toBe('fixture');
    // ...and the old rebind path is gone: a chat asks for the state of its
    // model, it does not restore one onto the runtime other chats share.
    expect(runtime.modelId).toBe('default-model');
    expect(runtime.restoreModel).not.toHaveBeenCalled();
  });
});

describe('model spec refresh without a restart', () => {
  it('refreshes a chat context window when the owner edits the spec for the same model', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession } = await import('../src/session-store.js');
    const model = new MockLanguageModelV3({ doStream: [fixtureText('Answer.')] });
    const runtime = runtimeFor(model);
    // The runtime resolves a chat's model through a factory cached by a settings
    // fingerprint (provider config + modelSpecs + catalog revision). An owner
    // editing the context limit invalidates that cache for the SAME identity.
    let window = 100_000;
    runtime.modelFor = async (providerId, modelId) => ({
      providerId,
      modelId,
      modelName: 'Local streaming fixture',
      providerName: 'Fixture',
      model,
      contextWindowTokens: window,
      outputLimitTokens: null,
      supportsVision: false,
      supportsImageToolResult: true,
      reasoningVariants: [],
      reasoningTitles: false,
      reasoningMetadataSource: null,
      reasoningSupport: 'model-unsupported',
      getReasoningProviderOptions: () => ({}),
      registry: new ToolRegistry(),
    });
    session = new AgentSessionController(runtime);
    await session.openSession(createSession('fixture', 'fixture'));
    await session.restoreSessionModel();
    expect(session.getSnapshot().session.contextWindowTokens).toBe(100_000);

    // The owner raises the limit while the host runs. The model identity is
    // unchanged, so only a fingerprint-aware refresh can pick it up.
    window = 200_000;
    await session.restoreSessionModel();
    // The reported window and the state compaction reads come from this same
    // refreshed model state: a restart or a model re-pick must not be required.
    expect(session.getSnapshot().session.contextWindowTokens).toBe(200_000);
  });

  it('keeps the chat model window after a step usage report', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession } = await import('../src/session-store.js');
    const model = new MockLanguageModelV3({ doStream: [fixtureText('Answer.')] });
    const runtime = runtimeFor(model);
    // The shared runtime slot holds the default model's window. The chat runs
    // with its own model state and never rebinds the runtime, so a step usage
    // report must still stamp the chat's window, not the default's.
    runtime.providerId = 'default-provider';
    runtime.modelId = 'default-model';
    runtime.contextWindowTokens = 100_000;
    runtime.modelFor = async (providerId, modelId) => ({
      providerId,
      modelId,
      modelName: 'Local streaming fixture',
      providerName: 'Fixture',
      model,
      contextWindowTokens: 200_000,
      outputLimitTokens: null,
      supportsVision: false,
      supportsImageToolResult: true,
      reasoningVariants: [],
      reasoningTitles: false,
      reasoningMetadataSource: null,
      reasoningSupport: 'model-unsupported',
      getReasoningProviderOptions: () => ({}),
      registry: new ToolRegistry(),
    });
    session = new AgentSessionController(runtime);
    await session.openSession(createSession('fixture', 'fixture'));
    await session.restoreSessionModel();
    expect(session.getSnapshot().session.contextWindowTokens).toBe(200_000);
    // agent.ts reports usage after every model step through this handler.
    (session as unknown as { onContextUsage: (a: number, b: number) => void }).onContextUsage(100, 120);
    expect(session.getSnapshot().session.contextWindowTokens).toBe(200_000);
  });
});

describe('compaction output limit source', () => {
  it('uses the chat model output limit for automatic compaction', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession } = await import('../src/session-store.js');
    const { COMPACTION_PROMPT } = await import('../src/compaction.js');
    let normalCalls = 0;
    let summaryCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async (request) => {
        const last = request.prompt.at(-1);
        if (last?.role === 'user' && last.content.some((part) => part.type === 'text' && part.text === COMPACTION_PROMPT)) {
          summaryCalls++;
          return fixtureText('Checkpoint: the fixture task continues.');
        }
        normalCalls++;
        return normalCalls === 1
          ? delayedStream(
              [{ type: 'tool-call', toolCallId: 'completed-before-compaction', toolName: 'inspect', input: '{}' }],
              'tool-calls',
              160_000,
            )
          : fixtureText('The task can continue.', 'stop', 160_000);
      },
    });
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'none' },
      autoApprove: () => true,
      execute: async () => ({ evidence: 'Original completed evidence. '.repeat(800) }),
    });
    const runtime = runtimeFor(model, registry);
    runtime.providerId = 'default-provider';
    runtime.modelId = 'default-model';
    runtime.contextWindowTokens = 200_000;
    // The shared runtime slot holds the default model's output. The chat runs
    // with its own model state; automatic compaction must reserve against the
    // chat model's output, never the default's.
    runtime.outputLimitTokens = 1_000;
    runtime.modelFor = async (providerId, modelId) => ({
      providerId,
      modelId,
      modelName: 'Local streaming fixture',
      providerName: 'Fixture',
      model,
      contextWindowTokens: 200_000,
      outputLimitTokens: 50_000,
      supportsVision: false,
      supportsImageToolResult: true,
      reasoningVariants: [],
      reasoningTitles: false,
      reasoningMetadataSource: null,
      reasoningSupport: 'model-unsupported',
      getReasoningProviderOptions: () => ({}),
      registry,
    });
    session = new AgentSessionController(runtime);
    await session.openSession(createSession('fixture', 'fixture'));
    await session.restoreSessionModel();
    // With window 200k, chat output 50k triggers at 150k; default output 1k
    // would hold the trigger at 178,421. First step reports 160k, so only the
    // chat output can fire compaction before the second step.
    await session.sendMessage({ text: 'Inspect the evidence.', images: [] });
    await session.flushSave();
    expect(normalCalls).toBe(2);
    expect(summaryCalls).toBe(1);
    expect(session.getLastRunError()).toBeNull();
  });

  it('uses the chat model output limit for manual compaction', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession } = await import('../src/session-store.js');
    const { COMPACTION_PROMPT } = await import('../src/compaction.js');
    let summaryCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async (request) => {
        const last = request.prompt.at(-1);
        if (last?.role === 'user' && last.content.some((part) => part.type === 'text' && part.text === COMPACTION_PROMPT)) {
          summaryCalls++;
          return fixtureText('Checkpoint: the fixture task continues.');
        }
        return fixtureText('Unexpected normal call.', 'stop', 10_000);
      },
    });
    const runtime = runtimeFor(model);
    runtime.providerId = 'default-provider';
    runtime.modelId = 'default-model';
    runtime.contextWindowTokens = 1_000_000;
    runtime.outputLimitTokens = 1_000;
    runtime.modelFor = async (providerId, modelId) => ({
      providerId,
      modelId,
      modelName: 'Local streaming fixture',
      providerName: 'Fixture',
      model,
      contextWindowTokens: 1_000_000,
      outputLimitTokens: 50_000,
      supportsVision: false,
      supportsImageToolResult: true,
      reasoningVariants: [],
      reasoningTitles: false,
      reasoningMetadataSource: null,
      reasoningSupport: 'model-unsupported',
      getReasoningProviderOptions: () => ({}),
      registry: new ToolRegistry(),
    });
    session = new AgentSessionController(runtime);
    await session.openSession({
      ...createSession('fixture', 'fixture'),
      entries: [{ kind: 'user', text: 'Keep the original task.' }],
      conversation: [{ role: 'user', content: 'Keep the original task.' }],
    });
    await session.restoreSessionModel();
    (session as unknown as { onContextUsage: (a: number, b: number) => void }).onContextUsage(10_000, 10_000);
    await session.compact();
    expect(summaryCalls).toBe(1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]!.maxOutputTokens).toBe(50_000);
    expect(session.getLastRunError()).toBeNull();
  });
});

describe('provider retry reporting', () => {
  it('keeps key selection per conversation across new sessions and reloads on a shared runtime', async () => {
    const { createRotatingModel } = await import('../src/provider/retry.js');
    const { AgentSessionController } = await import('../src/agent-session.js');
    const first = new MockLanguageModelV3({
      doStream: async () => {
        throw Object.assign(new Error('rate limit'), { statusCode: 429 });
      },
    });
    const second = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () =>
        delayedStream([
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Done.' },
          { type: 'text-end', id: 'answer' },
        ]),
    });
    const runtime = runtimeFor(second);
    runtime.model = createRotatingModel([first, second], { poolId: 'a'.repeat(64), delaysMs: [] });
    session = new AgentSessionController(runtime);
    await session.sendMessage({ text: 'First', images: [] });
    expect(session.getLastRunError()).toBeNull();
    const originalId = session.getSnapshot().session.id;
    await session.sendMessage({ text: 'Continue', images: [] });
    expect(first.doStreamCalls).toHaveLength(1);
    await session.createNewSession();
    await session.sendMessage({ text: 'New conversation', images: [] });
    expect(first.doStreamCalls).toHaveLength(2);
    expect(await session.loadSession(originalId)).not.toBeNull();
    await session.sendMessage({ text: 'Resume', images: [] });
    expect(session.getLastRunError()).toBeNull();
    expect(first.doStreamCalls).toHaveLength(2);
  });

  it('shows a retry as one line that updates in place and stays after recovery', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () =>
        delayedStream([
          { pause: 120 },
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Done.' },
          { type: 'text-end', id: 'answer' },
        ]),
    });
    let report:
      | ((event: {
          kind: 'retry' | 'rotate';
          keyIndex: number;
          attempt?: number;
          waitMs?: number;
          reason?: string;
          error: unknown;
        }) => void)
      | null = null;
    const runtime = runtimeFor(model);
    runtime.reportRetry = (handler) => {
      report = handler as typeof report;
    };
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtime);

    const running = session.sendMessage({ text: 'hello', images: [] });
    await vi.waitFor(() => expect(report).not.toBeNull());
    const fire = report as unknown as (event: Record<string, unknown>) => void;
    fire({ kind: 'retry', keyIndex: 0, attempt: 0, waitMs: 1_000, error: { statusCode: 429 } });
    fire({ kind: 'retry', keyIndex: 0, attempt: 1, waitMs: 2_000, error: { statusCode: 429 } });
    await running;

    const notices = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'notice');
    // One line for the whole sequence, carrying the latest attempt.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'notice', tone: 'warn' });
    const text = (notices[0] as { text: string }).text;
    expect(text).toContain('Rate limited (429)');
    expect(text).toContain('Retry 2 of');
    expect(text).toContain('2s');

    // It is a real session entry, so it survives a reload.
    await session.flushSave();
    const { loadSavedSession } = await import('../src/session-store.js');
    const saved = loadSavedSession(session.getSnapshot().session.id);
    expect(saved?.entries.filter((entry) => entry.kind === 'notice')).toHaveLength(1);
  });

  it('reports a key rotation in the same line', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () =>
        delayedStream([
          { pause: 120 },
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Done.' },
          { type: 'text-end', id: 'answer' },
        ]),
    });
    let report: ((event: Record<string, unknown>) => void) | null = null;
    const runtime = runtimeFor(model);
    runtime.reportRetry = (handler) => {
      report = handler as typeof report;
    };
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtime);

    const running = session.sendMessage({ text: 'hello', images: [] });
    await vi.waitFor(() => expect(report).not.toBeNull());
    (report as unknown as (event: Record<string, unknown>) => void)({
      kind: 'rotate',
      keyIndex: 0,
      reason: 'auth',
      error: { statusCode: 403 },
    });
    await running;

    const notices = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect((notices[0] as { text: string }).text).toContain('switching to the next key');
  });

  it('starts a new line for a retry after a tool-only step recovered', async () => {
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ message: 'Evidence' }),
    });
    let report: ((event: Record<string, unknown>) => void) | null = null;
    const fire = (attempt: number) => report?.({ kind: 'retry', keyIndex: 0, attempt, waitMs: 1_000, error: { statusCode: 429 } });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => {
          // Step 1 hits a 429, then recovers with a tool call and no text at all.
          fire(0);
          return delayedStream([{ type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' }], 'tool-calls');
        })
        .mockImplementationOnce(async () => {
          // Step 2 hits a fresh 429 once the tool result is back.
          fire(1);
          return fixtureText('Done.');
        }),
    });
    const runtime = runtimeFor(model, registry);
    runtime.reportRetry = (handler) => {
      report = handler as typeof report;
    };
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtime, undefined, { sessionWorkspaceRoot: null });

    await session.sendMessage({ text: 'hello', images: [] });

    const notices = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'notice');
    // The tool-only step streamed no text or reasoning, yet it recovered: the
    // second 429 is its own line, not an in-place update of the first.
    expect(notices).toHaveLength(2);
    expect((notices[0] as { text: string }).text).toContain('Retry 1 of');
    expect((notices[1] as { text: string }).text).toContain('Retry 2 of');
  });
});

describe('session streaming message boundaries', () => {
  it('keeps reasoning and assistant deltas in one entry across multiple repaint timers', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () =>
        delayedStream([
          { type: 'reasoning-start', id: 'reasoning' },
          { type: 'reasoning-delta', id: 'reasoning', delta: 'A simple ' },
          { pause: 80 },
          { type: 'reasoning-delta', id: 'reasoning', delta: 'greeting.' },
          { type: 'reasoning-end', id: 'reasoning' },
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Hello! 👋 How ca' },
          { pause: 80 },
          { type: 'text-delta', id: 'answer', delta: 'n I help ' },
          { pause: 80 },
          { type: 'text-delta', id: 'answer', delta: 'you today?' },
          { type: 'text-end', id: 'answer' },
        ]),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model));
    await session.sendMessage({ text: 'hello', images: [] });

    const snapshot = session.getSnapshot();
    const reasoningEntries = snapshot.session.entries.filter((entry) => entry.kind === 'reasoning');
    expect(reasoningEntries).toHaveLength(1);
    // The block keeps its text and now reports how long the model thought.
    expect(reasoningEntries[0]).toMatchObject({ kind: 'reasoning', text: 'A simple greeting.' });
    expect((reasoningEntries[0] as { durationMs?: number }).durationMs).toEqual(expect.any(Number));
    expect(snapshot.session.entries.filter((entry) => entry.kind === 'assistant')).toMatchObject([
      { kind: 'assistant', text: 'Hello! 👋 How can I help you today?' },
    ]);
    expect(snapshot.streamingAssistantEntry).toBeNull();
    expect(snapshot.busy).toBe(false);
  });

  it('records reasoning even when thinking is hidden, so the toggle only hides it', async () => {
    // Hiding reasoning used to drop the deltas at the source: the model had
    // already produced (and billed) them, but the session never stored them, so
    // switching thinking back on could not bring the history back.
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () =>
        delayedStream([
          { type: 'reasoning-start', id: 'reasoning' },
          { type: 'reasoning-delta', id: 'reasoning', delta: 'Hidden but stored.' },
          { type: 'reasoning-end', id: 'reasoning' },
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Done.' },
          { type: 'text-end', id: 'answer' },
        ]),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model));
    await session.sendMessage({ text: 'hello', images: [] });

    const entries = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'reasoning');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'reasoning', text: 'Hidden but stored.' });
  });

  it('stamps the thinking time the moment the reasoning block ends, while the tool input is still streaming', async () => {
    // A provider emits reasoning-end, then starts a tool call whose input streams
    // in chunks. The reasoning block is over at reasoning-end, but the thought
    // entry kept no duration until the call actually executed - for a gated or
    // very large call that can be minutes of an open "Thought" row.
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ status: 'completed', detail: 'Fixture result' }),
    });
    let releaseInputStream!: () => void;
    const inputGate = new Promise<void>((resolve) => {
      releaseInputStream = resolve;
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => ({
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'reasoning-start', id: 'reasoning' });
              controller.enqueue({ type: 'reasoning-delta', id: 'reasoning', delta: 'Check the file first.' });
              await delay(30);
              controller.enqueue({ type: 'reasoning-end', id: 'reasoning' });
              controller.enqueue({ type: 'tool-input-start', id: 'inspect-1', toolName: 'inspect' });
              controller.enqueue({ type: 'tool-input-delta', id: 'inspect-1', delta: '{"path":' });
              // The tool input is still streaming; the reasoning block ended long before this.
              await inputGate;
              controller.enqueue({ type: 'tool-input-end', id: 'inspect-1' });
              controller.enqueue({ type: 'tool-call', toolCallId: 'inspect-1', toolName: 'inspect', input: '{"path":"notes.md"}' });
              controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage });
              controller.close();
            },
          }),
        }))
        .mockImplementationOnce(async () => fixtureText('Done.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    const run = session.sendMessage({ text: 'inspect', images: [] });
    try {
      await vi.waitFor(() =>
        expect(session!.getSnapshot().session.entries.some((entry) => entry.kind === 'tool' && entry.preparing === true)).toBe(true),
      );
      // While the input is still streaming, the reasoning block that produced it
      // must already report its duration.
      const reasoning = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'reasoning');
      expect(reasoning).toHaveLength(1);
      expect((reasoning[0] as { durationMs?: number }).durationMs).toEqual(expect.any(Number));
    } finally {
      releaseInputStream();
    }
    await run;
  });

  it('stamps the thinking time when a tool call ends the block instead of assistant text', async () => {
    // A reasoning block is usually followed by a tool call, not by prose. The
    // tool boundary used to drop the pointer without stamping a duration, so
    // every such block kept a bare "Thought" label with no elapsed time.
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ status: 'completed', detail: 'Fixture result' }),
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream(
            [
              { type: 'reasoning-start', id: 'reasoning' },
              { type: 'reasoning-delta', id: 'reasoning', delta: 'Check the file first.' },
              { pause: 60 },
              { type: 'reasoning-end', id: 'reasoning' },
              { type: 'tool-call', toolCallId: 'inspect-1', toolName: 'inspect', input: '{}' },
            ],
            'tool-calls',
          ),
        )
        .mockImplementationOnce(async () =>
          delayedStream([
            { type: 'text-start', id: 'after' },
            { type: 'text-delta', id: 'after', delta: 'Done.' },
            { type: 'text-end', id: 'after' },
          ]),
        ),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    await session.sendMessage({ text: 'inspect', images: [] });

    const blocks = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'reasoning');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'reasoning', text: 'Check the file first.' });
    expect((blocks[0] as { durationMs?: number }).durationMs).toEqual(expect.any(Number));
  });

  it('starts a new assistant entry at a real tool boundary while joining deltas on both sides', async () => {
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ status: 'completed', detail: 'Fixture result' }),
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream(
            [
              { type: 'text-start', id: 'before' },
              { type: 'text-delta', id: 'before', delta: 'Checking ' },
              { pause: 80 },
              { type: 'text-delta', id: 'before', delta: 'the result.' },
              { type: 'text-end', id: 'before' },
              { type: 'tool-call', toolCallId: 'inspect-1', toolName: 'inspect', input: '{}' },
            ],
            'tool-calls',
          ),
        )
        .mockImplementationOnce(async () =>
          delayedStream([
            { type: 'text-start', id: 'after' },
            { type: 'text-delta', id: 'after', delta: 'Completed ' },
            { pause: 80 },
            { type: 'text-delta', id: 'after', delta: 'successfully.' },
            { type: 'text-end', id: 'after' },
          ]),
        ),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    await session.sendMessage({ text: 'inspect', images: [] });

    const entries = session.getSnapshot().session.entries;
    // A first message opens the transcript on its own: no day divider precedes it.
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'inspect' });
    expect(entries[1]).toMatchObject({ kind: 'assistant', text: 'Checking the result.' });
    expect(entries[2]).toMatchObject({ kind: 'tool', running: false });
    expect(entries[3]).toMatchObject({ kind: 'assistant', text: 'Completed successfully.' });
  });

  it('previews a tool call while its arguments stream, then shows the executed form', async () => {
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'file_write',
      description: 'A local fixture tool',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ status: 'completed', stdout: 'Saved fixture file', stderr: '' }),
    });
    let continueStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      continueStream = resolve;
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => ({
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'tool-input-start', id: 'write-1', toolName: 'file_write' });
              controller.enqueue({ type: 'tool-input-delta', id: 'write-1', delta: '{"path":"src/r' });
              controller.enqueue({ type: 'tool-input-delta', id: 'write-1', delta: 'untime.ts","content":"export const x = 1;"}' });
              await streamGate;
              controller.enqueue({ type: 'tool-input-end', id: 'write-1' });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'write-1',
                toolName: 'file_write',
                input: '{"path":"src/runtime.ts","content":"export const x = 1;"}',
              });
              controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage });
              controller.close();
            },
          }),
        }))
        .mockImplementationOnce(async () => fixtureText('Saved it.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    const run = session.sendMessage({ text: 'write the file', images: [] });

    try {
      await vi.waitFor(() => {
        const entry = session!.getSnapshot().session.entries.find((candidate) => candidate.kind === 'tool');
        expect(entry).toMatchObject({
          kind: 'tool',
          command: 'Write src/runtime.ts',
          result: '',
          preparing: true,
          tool: 'host:file_write',
        });
      });
      expect(session.getSnapshot().session.entries.some((entry) => entry.kind === 'tool' && entry.result === 'Saved fixture file')).toBe(
        false,
      );
    } finally {
      continueStream();
    }
    await run;

    const toolEntries = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'tool');
    expect(toolEntries).toMatchObject([
      {
        kind: 'tool',
        input: { path: 'src/runtime.ts', content: 'export const x = 1;' },
        result: 'Wrote',
        running: false,
        tool: 'host:file_write',
      },
    ]);
    expect(toolEntries[0]).not.toHaveProperty('command');
  });

  it('keeps text that keeps streaming after a tool call starts in the same assistant entry', async () => {
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ status: 'completed', detail: 'Fixture result' }),
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream(
            [
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'I am updating the notes (' },
              { pause: 80 },
              { type: 'tool-input-start', id: 'inspect-1', toolName: 'inspect' },
              { type: 'tool-input-delta', id: 'inspect-1', delta: '{}' },
              { pause: 80 },
              { type: 'text-delta', id: 'answer', delta: 'including the details).' },
              { type: 'text-end', id: 'answer' },
              { type: 'tool-input-end', id: 'inspect-1' },
              { type: 'tool-call', toolCallId: 'inspect-1', toolName: 'inspect', input: '{}' },
            ],
            'tool-calls',
          ),
        )
        .mockImplementationOnce(async () => fixtureText('Done.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    await session.sendMessage({ text: 'inspect', images: [] });

    const entries = session.getSnapshot().session.entries;
    // A first message opens the transcript on its own: no day divider precedes it.
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'inspect' });
    expect(entries[1]).toMatchObject({ kind: 'assistant', text: 'I am updating the notes (including the details).' });
    expect(entries[2]).toMatchObject({ kind: 'tool', running: false });
    expect(entries[3]).toMatchObject({ kind: 'assistant', text: 'Done.' });
  });

  it('keeps a completed tool step in the session if the next provider step fails', async () => {
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => ({ status: 'completed', detail: 'Saved fixture result' }),
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream(
            [
              { type: 'text-start', id: 'step-one' },
              { type: 'text-delta', id: 'step-one', delta: 'I checked the file.' },
              { type: 'text-end', id: 'step-one' },
              { type: 'tool-call', toolCallId: 'inspect-completed', toolName: 'inspect', input: '{}' },
            ],
            'tool-calls',
          ),
        )
        .mockImplementationOnce(async () => {
          throw new Error('Tool result is missing for tool call later-step.');
        }),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    const sessionId = session.getSnapshot().session.id;

    await session.sendMessage({ text: 'Inspect, then summarize.', images: [] });
    await session.flushSave();

    const saved = loadSavedSession(sessionId)!;
    const conversationParts = saved.conversation.flatMap((message) =>
      Array.isArray(message.content) ? (message.content as Array<{ type: string; toolCallId?: string }>) : [],
    );
    const completedExchange = conversationParts.filter((part) => part.toolCallId === 'inspect-completed');
    expect(completedExchange.map((part) => part.type)).toEqual(['tool-call', 'tool-result']);
    expect(JSON.stringify(saved.conversation)).toContain('I checked the file.');
    expect(JSON.stringify(completedExchange)).toContain('Saved fixture result');
    expect(saved.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('later-step'))).toBe(true);
  });
});

describe('session compaction persistence and continuation', () => {
  it('compacts twice in one tool run when the context fills again, preserving queued input and the complete archive', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    const { COMPACTION_PROMPT } = await import('../src/compaction.js');
    let normalCalls = 0;
    let summaryCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async (request) => {
        const last = request.prompt.at(-1);
        if (last?.role === 'user' && last.content.some((part) => part.type === 'text' && part.text === COMPACTION_PROMPT)) {
          return fixtureText(`Checkpoint ${++summaryCalls}: preserve the original task, queued constraints, and all findings.`);
        }
        normalCalls++;
        if (normalCalls === 4) return fixtureText('The original task is complete.', 'stop', 20_000);
        return delayedStream(
          [
            { type: 'reasoning-start', id: `reasoning-${normalCalls}` },
            { type: 'reasoning-delta', id: `reasoning-${normalCalls}`, delta: `Step ${normalCalls} evidence. `.repeat(500) },
            { type: 'reasoning-end', id: `reasoning-${normalCalls}` },
            { type: 'text-start', id: `text-${normalCalls}` },
            { type: 'text-delta', id: `text-${normalCalls}`, delta: `Inspecting result ${normalCalls}.` },
            { type: 'text-end', id: `text-${normalCalls}` },
            { type: 'tool-call', toolCallId: `call-${normalCalls}`, toolName: 'inspect', input: '{}' },
          ],
          'tool-calls',
          normalCalls === 2 ? 20_000 : 90_000,
        );
      },
    });
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        executions++;
        if (executions === 1) {
          void session!.sendMessage({
            text: 'Keep the queued constraint.',
            images: [],
            communication: { source: 'terminal', replyTo: { channel: 'terminal' } },
          });
          session!.manageQueuedMessage(session!.getSnapshot().queuedMessages[0]!.id!, 'steer', session!.getSnapshot().session.id);
        }
        return { finding: `Original tool result ${executions}. ` + 'Detailed evidence. '.repeat(1_000) };
      },
    });
    const runtime = runtimeFor(model, registry);
    runtime.contextWindowTokens = 100_000;
    runtime.outputLimitTokens = 20_000;
    const original: ModelMessage[] = [
      { role: 'user', content: 'Original task: inspect both results.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Earlier reasoning. '.repeat(1_000) },
          { type: 'text', text: 'Initial progress.' },
        ],
      },
    ];
    session = new AgentSessionController(runtime, undefined, { sessionWorkspaceRoot: null });
    await session.openSession({
      ...createSession('fixture', 'fixture'),
      conversation: original,
      entries: [{ kind: 'user', text: 'Original task: inspect both results.' }],
    });
    const id = session.getSnapshot().session.id;
    await session.sendMessage({
      text: 'Continue the original task.',
      images: [],
      communication: { source: 'terminal', replyTo: { channel: 'terminal' } },
    });
    await session.flushSave();
    expect(summaryCalls).toBe(2);
    expect(normalCalls).toBe(4);
    expect(executions).toBe(3);
    expect(session.getLastRunError()).toBeNull();
    const saved = loadSavedSession(id)!;
    expect(saved.contextTokens).toBe(20_000);
    expect(JSON.stringify(saved.conversation)).toContain('Checkpoint 2:');
    expect(JSON.stringify(saved.conversation)).not.toContain('Checkpoint 1:');
    expect(saved.conversationArchive!.slice(0, original.length)).toEqual(original);
    for (const messages of [saved.conversation, saved.conversationArchive!]) {
      const queued = messages.filter(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === 'text' && part.text.includes('Keep the queued constraint.')),
      );
      expect(queued).toHaveLength(1);
    }
    const archivedCalls = saved.conversationArchive!.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'tool-call' || part.type === 'tool-result') : [],
    );
    expect(archivedCalls.filter((part) => 'toolCallId' in part && part.toolCallId === 'call-1')).toHaveLength(2);
    expect(archivedCalls.filter((part) => 'toolCallId' in part && part.toolCallId === 'call-2')).toHaveLength(2);
    expect(archivedCalls.filter((part) => 'toolCallId' in part && part.toolCallId === 'call-3')).toHaveLength(2);
    expect(JSON.stringify(saved.conversationArchive)).toContain('Original tool result 1.');
    expect(JSON.stringify(saved.conversationArchive)).toContain('Original tool result 2.');
    expect(JSON.stringify(saved.conversationArchive)).toContain('Original tool result 3.');
  });

  it('keeps the run alive when automatic compaction fails and retries it on a later turn', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    const { COMPACTION_PROMPT } = await import('../src/compaction.js');
    let normalCalls = 0;
    let summaryCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async (request) => {
        const last = request.prompt.at(-1);
        if (last?.role === 'user' && last.content.some((part) => part.type === 'text' && part.text === COMPACTION_PROMPT)) {
          summaryCalls++;
          return summaryCalls === 1
            ? fixtureText('Incomplete checkpoint.', 'length')
            : fixtureText('Complete retry checkpoint of the original task and tool evidence.');
        }
        normalCalls++;
        return normalCalls === 1
          ? delayedStream(
              [{ type: 'tool-call', toolCallId: 'completed-before-failure', toolName: 'inspect', input: '{}' }],
              'tool-calls',
              90_000,
            )
          : fixtureText('The task can continue.', 'stop', 90_000);
      },
    });
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'none' },
      autoApprove: () => true,
      execute: async () => ({ evidence: 'Original completed evidence. '.repeat(800) }),
    });
    const runtime = runtimeFor(model, registry);
    runtime.contextWindowTokens = 100_000;
    runtime.outputLimitTokens = 20_000;
    session = new AgentSessionController(runtime);
    await session.openSession({
      ...createSession('fixture', 'fixture'),
      entries: [{ kind: 'user', text: 'Keep the original task.' }],
      conversation: [{ role: 'user', content: 'Keep the original task.' }],
    });
    const id = session.getSnapshot().session.id;
    await session.sendMessage({ text: 'Inspect the evidence.', images: [] });
    await session.flushSave();
    // A summarization failure must never cost the owner their message: the run
    // finished, the transcript explains the failure, and no partial checkpoint
    // was applied (2026-11-03 incident contract).
    expect(session.getLastRunError()).toBeNull();
    expect(session.isBusy).toBe(false);
    expect(summaryCalls).toBeGreaterThanOrEqual(1);
    expect(normalCalls).toBe(2);
    const entries = session.getSnapshot().session.entries;
    expect(entries.some((entry) => entry.kind === 'notice' && /Compaction failed:.*cut off/.test(entry.text))).toBe(true);
    expect(entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('The task can continue.'))).toBe(true);
    const failed = loadSavedSession(id)!;
    expect(JSON.stringify(failed.conversation)).toContain('completed-before-failure');
    expect(JSON.stringify(failed.conversation)).toContain('Original completed evidence.');
    expect(JSON.stringify(failed.conversation)).not.toContain('Incomplete checkpoint.');
    expect(failed.conversationArchive).toBeUndefined();
    await session.sendMessage({ text: 'Retry compaction and continue.', images: [] });
    expect(summaryCalls).toBeGreaterThan(1);
    expect(session.getLastRunError()).toBeNull();
  });

  it('classifies a refused compaction with a machine-readable cause on the notice', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    const model = new MockLanguageModelV3({
      // The provider's own input measurement is what makes the budget arithmetic
      // real: without a previousContextTokens measurement the refusal path stays
      // unreachable by design (the provider gets to validate the actual request).
      doStream: async () => fixtureText('The turn continues despite the refusal.', 'stop', 30_000),
    });
    const runtime = runtimeFor(model);
    // A measured context of 30k against a 10k window, plus one conversation
    // message far larger than the window: neither the full summarization request
    // nor the sliced fallback can fit, so compactConversation reports a refusal
    // as data and the turn must survive it.
    runtime.contextWindowTokens = 10_000;
    const oversized = 'context '.repeat(50_000);
    session = new AgentSessionController(runtime);
    await session.openSession({
      ...createSession('fixture', 'fixture'),
      entries: [{ kind: 'user', text: oversized }],
      conversation: [{ role: 'user', content: oversized }],
    });
    await session.sendMessage({ text: 'Keep going.', images: [] });
    await session.waitUntilIdle(1000);
    await session.compact();
    await session.flushSave();
    expect(session.getLastRunError()).toBeNull();
    const notices = session
      .getSnapshot()
      .session.entries.filter(
        (entry): entry is Extract<SessionEntry, { kind: 'notice' }> =>
          entry.kind === 'notice' && entry.text.startsWith('Compaction does not fit the budget'),
      );
    expect(notices.length).toBeGreaterThan(0);
    // The prose stays owner-facing; the cause band is the stable key for tooling,
    // and it survives the save so a later reader can classify without parsing.
    expect(notices[0]).toMatchObject({ kind: 'notice', tone: 'warn', cause: 'compaction:exceeds-window' });
    const saved = loadSavedSession(session.getSnapshot().session.id);
    expect(saved?.entries.some((entry) => entry.kind === 'notice' && entry.cause === 'compaction:exceeds-window')).toBe(true);
  });

  it('serves a compaction requested mid-run at the next step boundary instead of after the whole run', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { COMPACTION_PROMPT } = await import('../src/compaction.js');
    const order: string[] = [];
    let normalCalls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async (request) => {
        const last = request.prompt.at(-1);
        if (last?.role === 'user' && last.content.some((part) => part.type === 'text' && part.text === COMPACTION_PROMPT)) {
          order.push('compaction');
          return fixtureText('Checkpoint: the fixture task continues.');
        }
        normalCalls++;
        order.push(`step-${normalCalls}`);
        if (normalCalls === 1)
          return delayedStream(
            [
              { type: 'text-start', id: 'step-one' },
              { type: 'text-delta', id: 'step-one', delta: 'Inspecting the workspace.' },
              { type: 'text-end', id: 'step-one' },
              { type: 'tool-input-start', id: 'inspect-1', toolName: 'inspect' },
              { type: 'tool-input-end', id: 'inspect-1' },
              { type: 'tool-call', toolCallId: 'inspect-1', toolName: 'inspect', input: '{}' },
            ],
            'tool-calls',
          );
        return fixtureText('Fixture task complete.');
      },
    });
    const registry = new ToolRegistry();
    let requested = false;
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        if (!requested) {
          requested = true;
          await session!.compact();
        }
        return { status: 'completed', detail: 'Fixture result' };
      },
    });
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    await session.sendMessage({ text: 'inspect the workspace', images: [] });
    // The compaction is requested while the run is in flight; wait for it so the
    // assertion reports the real position instead of racing the run's teardown.
    await vi.waitFor(() => expect(order).toContain('compaction'), { timeout: 2_000, interval: 20 });
    expect(order).toEqual(['step-1', 'compaction', 'step-2']);
  });

  it('keeps a compaction for another workspace scope queued until the run finishes', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { COMPACTION_PROMPT } = await import('../src/compaction.js');
    const order: string[] = [];
    let normalCalls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async (request) => {
        const last = request.prompt.at(-1);
        if (last?.role === 'user' && last.content.some((part) => part.type === 'text' && part.text === COMPACTION_PROMPT)) {
          order.push('compaction');
          return fixtureText('Checkpoint: the fixture task continues.');
        }
        normalCalls++;
        order.push(`step-${normalCalls}`);
        if (normalCalls === 1)
          return delayedStream(
            [
              { type: 'tool-input-start', id: 'inspect-1', toolName: 'inspect' },
              { type: 'tool-input-end', id: 'inspect-1' },
              { type: 'tool-call', toolCallId: 'inspect-1', toolName: 'inspect', input: '{}' },
            ],
            'tool-calls',
          );
        return fixtureText('Fixture task complete.');
      },
    });
    const registry = new ToolRegistry();
    let requested = false;
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'A local fixture tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        if (!requested) {
          requested = true;
          // Changing the scope mid-run would move the active turn, so this
          // request may only run once the run has finished.
          await session!.compact(false, join(tmpdir(), 'openbutler-other-scope'));
        }
        return { status: 'completed', detail: 'Fixture result' };
      },
    });
    session = new AgentSessionController(runtimeFor(model, registry), undefined, { sessionWorkspaceRoot: null });
    await session.sendMessage({ text: 'inspect the workspace', images: [] });
    await vi.waitFor(() => expect(order).toContain('compaction'), { timeout: 2_000, interval: 20 });
    expect(order).toEqual(['step-1', 'step-2', 'compaction']);
  });

  it('shows compaction text and reasoning while streaming and commits the checkpoint only after completion', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    let finish!: () => void;
    const finishing = new Promise<void>((resolveFinish) => {
      finish = resolveFinish;
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'reasoning-start', id: 'summary-reasoning' });
            controller.enqueue({ type: 'reasoning-delta', id: 'summary-reasoning', delta: 'Preserving the current task.' });
            controller.enqueue({ type: 'reasoning-end', id: 'summary-reasoning' });
            controller.enqueue({ type: 'text-start', id: 'summary-text' });
            controller.enqueue({ type: 'text-delta', id: 'summary-text', delta: 'Summary in progress.' });
            await finishing;
            controller.enqueue({ type: 'text-delta', id: 'summary-text', delta: ' The checkpoint is complete.' });
            controller.enqueue({ type: 'text-end', id: 'summary-text' });
            controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
            controller.close();
          },
        }),
      }),
    });
    const raw: ModelMessage[] = [
      { role: 'user', content: 'Preserve the active task.' },
      { role: 'assistant', content: 'Work is in progress.' },
    ];
    const source = structuredClone(raw);
    session = new AgentSessionController(runtimeFor(model));
    await session.openSession({
      ...createSession('fixture', 'fixture'),
      entries: [{ kind: 'user', text: 'Preserve the active task.' }],
      conversation: raw,
    });
    const id = session.getSnapshot().session.id;
    const pending = session.compact();
    try {
      await vi.waitFor(
        () => {
          const snapshot = session!.getSnapshot();
          expect(snapshot.busy).toBe(true);
          expect(snapshot.streamingAssistantEntry).toMatchObject({ kind: 'assistant', text: 'Summary in progress.' });
          // The stamp that ends the thinking block rewrites the row, so its
          // provenance has to survive that rewrite or the transcript loses track
          // of whose reasoning it is.
          expect(snapshot.session.entries).toContainEqual(
            expect.objectContaining({ kind: 'reasoning', text: 'Preserving the current task.', internal: 'compaction' }),
          );
        },
        { timeout: 1_000, interval: 25 },
      );
      await session.flushSave();
      expect(loadSavedSession(id)!.conversation).toEqual(source);
      expect(loadSavedSession(id)!.conversationArchive).toBeUndefined();
    } finally {
      finish();
      await pending;
    }
    await session.flushSave();
    const saved = loadSavedSession(id)!;
    expect(saved.conversationArchive).toEqual(source);
    expect(JSON.stringify(saved.conversation)).toContain('Summary in progress. The checkpoint is complete.');
    expect(saved.entries).toContainEqual(
      expect.objectContaining({
        kind: 'assistant',
        text: 'Summary in progress. The checkpoint is complete.',
        internal: 'compaction',
      }),
    );
    expect(saved.entries).toContainEqual(
      expect.objectContaining({ kind: 'reasoning', text: 'Preserving the current task.', internal: 'compaction' }),
    );
    expect(session.getSnapshot().streamingAssistantEntry).toBeNull();
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it.each(['manual', 'automatic'] as const)('preserves the selected provider settings during %s compaction', async (mode) => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession } = await import('../src/session-store.js');
    const { estimateContextTokens } = await import('../src/compaction.js');
    const { getAgentContext } = await import('../src/agent.js');
    const raw: ModelMessage[] = [
      { role: 'user', content: 'Continue the implementation.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Historical evidence '.repeat(3_000) },
          { type: 'text', text: 'Work is in progress.' },
        ],
      },
    ];
    const model = new MockLanguageModelV3({
      doStream: [fixtureText('Detailed checkpoint of the implementation.'), fixtureText('Continuing the task.')],
    });
    const providerOptions = { fixture: { reasoningEffort: 'xhigh', cache_salt: 'conversation-cache' } };
    const runtime = runtimeFor(model);
    runtime.contextWindowTokens = 100_000;
    runtime.outputLimitTokens = 32_768;
    runtime.getReasoningProviderOptions = vi.fn(() => providerOptions);
    session = new AgentSessionController(runtime);
    await session.openSession({
      ...createSession('fixture', 'fixture'),
      entries: [{ kind: 'user', text: 'Continue the implementation.' }],
      conversation: raw,
      contextTokens: 90_000,
      contextEstimateTokens: estimateContextTokens(getAgentContext(raw, undefined, dataDir)),
    });
    // The chat owns its effort: the pick is recorded on the session, and both
    // the compaction request and the admitted turn then run with it.
    session.setReasoningPreference('xhigh');
    session.setShowReasoningPreference(true);
    if (mode === 'manual') await session.compact();
    else await session.sendMessage({ text: 'Continue.', images: [] });
    expect(model.doStreamCalls).toHaveLength(mode === 'manual' ? 1 : 2);
    for (const request of model.doStreamCalls) expect(request.providerOptions).toEqual(providerOptions);
    // The chat's own effort governs the compaction request as well as the
    // admitted message that triggered it.
    expect(runtime.getReasoningProviderOptions).toHaveBeenCalledWith('xhigh', true);
  });

  it('pins every request of this chat to its session id on a gateway provider', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession } = await import('../src/session-store.js');
    const { sessionAffinityProviderOptions } = await import('../src/provider/registry.js');
    const model = new MockLanguageModelV3({ doStream: [fixtureText('Answer.')] });
    const runtime = runtimeFor(model);
    // The fragment comes from the real registry, so the namespace decision is
    // the production one; the chat's job is to merge it into every request.
    runtime.sessionAffinityProviderOptions = (sessionId) =>
      sessionAffinityProviderOptions(
        {
          id: 'vercel',
          displayName: 'Vercel',
          npm: '@ai-sdk/gateway',
          apiKey: null,
          apiKeys: [],
          baseURL: undefined,
          options: {},
          custom: false,
        },
        sessionId,
      );
    session = new AgentSessionController(runtime);
    const opened = createSession('fixture', 'fixture');
    await session.openSession(opened);
    await session.sendMessage({ text: 'Hello.', images: [] });
    expect(model.doStreamCalls.length).toBeGreaterThan(0);
    for (const request of model.doStreamCalls) {
      expect(request.providerOptions?.gateway).toEqual({ sessionId: opened.id });
    }
  });

  it('resolves the machine default against the ladder of the model this chat runs', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession } = await import('../src/session-store.js');
    const model = new MockLanguageModelV3({ doStream: [fixtureText('Answer.')] });
    const runtime = runtimeFor(model);
    // The runtime holds a model whose ladder does NOT offer "minimal", so the
    // value it publishes has already been demoted to that model's ladder.
    runtime.reasoningVariants = [
      { id: 'default', label: 'Default', providerOptions: {} },
      { id: 'low', label: 'Low', providerOptions: {} },
      { id: 'medium', label: 'Medium', providerOptions: {} },
      { id: 'high', label: 'High', providerOptions: {} },
    ];
    runtime.reasoningDefault = 'low';
    // The raw machine preference is "minimal".
    runtime.reasoningPreference = 'minimal';
    // This chat runs a model whose ladder DOES offer "minimal".
    // The provider options come from the model STATE this chat runs with, not
    // from the runtime's own model, so the spy below sees the effort the chat
    // actually asked for.
    const stateOptions = vi.fn(() => ({}));
    runtime.modelFor = async () => ({
      providerId: 'fixture',
      modelId: 'fixture',
      modelName: 'Local streaming fixture',
      providerName: 'Fixture',
      model,
      contextWindowTokens: null,
      outputLimitTokens: null,
      supportsVision: false,
      supportsImageToolResult: true,
      reasoningVariants: [
        { id: 'default', label: 'Default', providerOptions: {} },
        { id: 'minimal', label: 'Minimal', providerOptions: {} },
        { id: 'low', label: 'Low', providerOptions: {} },
        { id: 'medium', label: 'Medium', providerOptions: {} },
      ],
      reasoningTitles: false,
      reasoningMetadataSource: null,
      reasoningSupport: 'available',
      getReasoningProviderOptions: stateOptions,
      registry: new ToolRegistry(),
    });
    runtime.getReasoningProviderOptions = vi.fn(() => ({}));
    session = new AgentSessionController(runtime);
    await session.openSession(createSession('fixture', 'fixture'));
    // The chat never chose an effort, so it inherits the machine default.
    await session.sendMessage({ text: 'Hello.', images: [] });
    // The inherited default is resolved against THIS chat's ladder, so the
    // raw "minimal" survives instead of the runtime's demoted "low", and the
    // chat's own model state is the one that maps it to provider options.
    expect(stateOptions).toHaveBeenCalledWith('minimal', true);
  });

  it('reuses the frozen system prompt for the compaction request and refreshes it only after the summary', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { buildAgentSystem } = await import('../src/agent.js');
    const { COMPACTION_PROMPT } = await import('../src/compaction.js');
    const model = new MockLanguageModelV3({
      doStream: [fixtureText('First answer.'), fixtureText('Checkpoint written.'), fixtureText('Second answer.')],
    });
    const runtime = runtimeFor(model);
    const rows: Array<{ runKind: string; tokens: { inputTokens?: number } }> = [];
    runtime.recordUsage = (input) => {
      rows.push(input);
    };
    session = new AgentSessionController(runtime);

    // First turn freezes the prompt; the provider caches system + messages.
    await session.sendMessage({ text: 'first', images: [] });
    const firstRequest = model.doStreamCalls[0]!;
    expect(firstRequest.prompt[0]!.role).toBe('system');
    const frozenSystem = firstRequest.prompt[0]!.content;
    expect(typeof frozenSystem).toBe('string');

    // Reference data drifts after the freeze: a rebuild would produce other bytes.
    mkdirSync(join(dataDir, 'MEMORY'), { recursive: true });
    writeFileSync(join(dataDir, 'MEMORY', 'MEMORY.md'), '- a durable fact learned this turn\n', 'utf8');
    expect(buildAgentSystem(runtime.workspaceRoot)).not.toBe(frozenSystem);

    // The compaction request must share that prefix: only its appended prompt is new.
    await session.compact();
    expect(model.doStreamCalls).toHaveLength(2);
    const compactionRequest = model.doStreamCalls[1]!;
    expect(JSON.stringify(compactionRequest.prompt)).toContain(COMPACTION_PROMPT.slice(0, 40));
    expect(compactionRequest.prompt[0]!.content).toBe(frozenSystem);

    // Compaction is a first-class request in the ledger, not a chat step.
    expect(rows.map((row) => row.runKind)).toEqual(['chat', 'compaction']);
    expect(rows[1]!.tokens.inputTokens).toBeGreaterThan(0);

    // The refresh lands after the summary, so the next turn reads fresh
    // reference data and pays for it once, at the prefix boundary.
    await session.sendMessage({ text: 'second', images: [] });
    const refreshed = model.doStreamCalls[2]!.prompt[0]!.content;
    expect(refreshed).toBe(buildAgentSystem(runtime.workspaceRoot));
    expect(refreshed).not.toBe(frozenSystem);
  });

  it('retains measured context when selecting the same model on another provider, then compacts before continuing', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession } = await import('../src/session-store.js');
    const { estimateContextTokens, COMPACTION_PROMPT } = await import('../src/compaction.js');
    const { getAgentContext } = await import('../src/agent.js');
    const raw: ModelMessage[] = [
      { role: 'user', content: 'Continue this task.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Current evidence '.repeat(4_000) },
          { type: 'text', text: 'Work is in progress.' },
        ],
      },
    ];
    const model = new MockLanguageModelV3({ doStream: [fixtureText('Complete checkpoint.'), fixtureText('Continuing the task.')] });
    const runtime = runtimeFor(model);
    runtime.contextWindowTokens = 262_144;
    runtime.outputLimitTokens = 32_768;
    runtime.selectModel = async (providerId, modelId) => {
      runtime.providerId = providerId;
      runtime.modelId = modelId;
    };
    session = new AgentSessionController(runtime);
    const estimate = estimateContextTokens(getAgentContext(raw, undefined, dataDir));
    await session.openSession({
      ...createSession('fixture', 'fixture'),
      entries: [{ kind: 'user', text: 'Continue this task.' }],
      conversation: raw,
      contextTokens: 239_000,
      contextEstimateTokens: estimate,
    });
    await session.selectModel('another-endpoint', 'fixture');
    expect(session.getSnapshot().session.contextTokens).toBe(239_000);
    await session.flushSave();
    const { loadSavedSession } = await import('../src/session-store.js');
    expect(loadSavedSession(session.getSnapshot().session.id)!.conversation).toEqual(raw);
    await session.sendMessage({ text: 'Continue.', images: [] });
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[0]!.prompt.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: COMPACTION_PROMPT }] });
    expect(model.doStreamCalls[1]!.prompt.at(-1)).not.toEqual(model.doStreamCalls[0]!.prompt.at(-1));
  });

  it('commits explicitly requested recovery only after the summary completes and keeps the complete original archive', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    const { estimateContextTokens } = await import('../src/compaction.js');
    const { getAgentContext } = await import('../src/agent.js');
    const raw: ModelMessage[] = [
      { role: 'user', content: 'Preserve the complete user message.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Historical reasoning '.repeat(8_000) },
          { type: 'text', text: 'Preserve this response.' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Most recent reasoning.' },
          { type: 'text', text: 'Current progress.' },
        ],
      },
    ];
    const model = new MockLanguageModelV3({ doStream: async () => fixtureText('Complete recovered checkpoint.') });
    const runtime = runtimeFor(model);
    runtime.contextWindowTokens = 262_144;
    runtime.outputLimitTokens = 32_768;
    const options = { fixture: { reasoningEffort: 'xhigh' } };
    runtime.getReasoningProviderOptions = () => options;
    session = new AgentSessionController(runtime);
    await session.openSession({
      ...createSession('fixture', 'fixture'),
      entries: [{ kind: 'user', text: 'Preserve the complete user message.' }],
      conversation: raw,
      contextTokens: 258_950,
      contextEstimateTokens: estimateContextTokens(getAgentContext(raw, undefined, dataDir)),
    });
    await session.compact(true);
    await session.flushSave();
    const saved = loadSavedSession(session.getSnapshot().session.id)!;
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]!.providerOptions).toEqual(options);
    expect(saved.conversationArchive).toEqual(raw);
    expect(saved.conversation).toContainEqual(raw[0]);
    expect(JSON.stringify(saved.conversation)).toContain('Preserve this response.');
    expect(JSON.stringify(saved.conversation)).toContain('Complete recovered checkpoint.');
    expect(saved.contextTokens).toBeUndefined();
    expect(saved.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Recovering compaction:'))).toBe(true);
  });

  it('preserves the raw archive and visible dialogue across repeated compaction, while persisting provider usage', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    const reasoning = 'Old internal reasoning '.repeat(3_000);
    const raw: ModelMessage[] = [
      { role: 'user', content: 'Implement the runtime; do not restart services.' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: reasoning },
          { type: 'text', text: 'Inspecting src/runtime.ts.' },
          { type: 'tool-call', toolCallId: 'original-call', toolName: 'file_read', input: { path: 'src/runtime.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'original-call',
            toolName: 'file_read',
            output: { type: 'text', value: 'Original file data '.repeat(3_000) },
          },
        ],
      },
    ];
    const source = structuredClone(raw);
    const model = new MockLanguageModelV3({
      doStream: [
        fixtureText('src/runtime.ts owns the runtime. Implementation remains unfinished. Do not restart services.'),
        fixtureText('Continuing the implementation.'),
        fixtureText('Merged checkpoint with the original constraints and current progress.'),
      ],
    });
    session = new AgentSessionController(runtimeFor(model));
    await session.openSession({
      ...createSession('fixture', 'fixture'),
      title: 'Existing task',
      entries: [{ kind: 'user', text: 'Implement the runtime; do not restart services.' }],
      conversation: raw,
    });
    const id = session.getSnapshot().session.id;
    await session.compact();
    await session.flushSave();
    const checkpoint = loadSavedSession(id)!;
    expect(checkpoint.conversationArchive).toEqual(source);
    expect(checkpoint.conversation).toContainEqual(raw[0]);
    expect(checkpoint.conversation).toContainEqual({ role: 'assistant', content: [{ type: 'text', text: 'Inspecting src/runtime.ts.' }] });
    expect(JSON.stringify(checkpoint.conversation)).not.toContain(reasoning);

    await session.sendMessage({ text: 'Continue safely.', images: [] });
    await session.flushSave();
    const resumed = loadSavedSession(id)!;
    expect(resumed.contextTokens).toBe(100);
    expect(resumed.contextEstimateTokens).toBeGreaterThan(0);
    expect(resumed.conversationArchive!.slice(0, 3)).toEqual(source);
    expect(resumed.conversationArchive).toHaveLength(5);
    await session.compact();
    await session.flushSave();
    const repeated = loadSavedSession(id)!;
    expect(repeated.conversationArchive).toEqual(resumed.conversationArchive);
    expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).not.toContain(reasoning);
    expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).toContain('Do not restart services.');
    const continuation = resumed.conversation.find(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'text' && part.text === 'Continue safely.'),
    )!;
    expect(continuation).toBeDefined();
    expect(repeated.conversation.filter((message) => JSON.stringify(message) === JSON.stringify(continuation))).toHaveLength(1);
    expect(repeated.contextTokens).toBeUndefined();
    expect(repeated.contextEstimateTokens).toBeUndefined();
    expect(raw).toEqual(source);
    expect(model.doStreamCalls).toHaveLength(3);
  });

  it('keeps a failed checkpoint out of both the active prompt and saved archive', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { createSession, loadSavedSession } = await import('../src/session-store.js');
    const raw: ModelMessage[] = [
      { role: 'user', content: 'The unfinished original request.' },
      { role: 'assistant', content: 'Original progress.' },
    ];
    const source = structuredClone(raw);
    const model = new MockLanguageModelV3({
      doStream: [fixtureText('Incomplete checkpoint must not be committed.', 'length'), fixtureText('Continuing the original request.')],
    });
    session = new AgentSessionController(runtimeFor(model));
    await session.openSession({
      ...createSession('fixture', 'fixture'),
      title: 'Existing task',
      entries: [{ kind: 'user', text: 'The unfinished original request.' }],
      conversation: raw,
      contextTokens: 90_000,
    });
    const id = session.getSnapshot().session.id;
    await session.compact();
    await session.flushSave();
    const saved = loadSavedSession(id)!;
    expect(saved.conversation).toEqual(source);
    expect(saved.conversationArchive).toBeUndefined();
    expect(saved.contextTokens).toBe(90_000);
    expect(saved.entries).toContainEqual(
      expect.objectContaining({ kind: 'assistant', text: 'Incomplete checkpoint must not be committed.' }),
    );
    expect(saved.entries.some((entry) => entry.kind === 'notice' && entry.text.includes('Compaction failed:'))).toBe(true);
    await session.sendMessage({ text: 'Continue.', images: [] });
    const resumedPrompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(resumedPrompt).toContain('The unfinished original request.');
    expect(resumedPrompt).not.toContain('Incomplete checkpoint');
    expect(resumedPrompt).not.toContain('Continue the unfinished user request from the compacted history');
    expect(model.doStreamCalls).toHaveLength(2);
  });
});

describe('session questions', () => {
  function questionCall(input: string) {
    return delayedStream([{ type: 'tool-call', toolCallId: 'ask-1', toolName: 'question', input }], 'tool-calls');
  }

  it('surfaces the pending question, delivers the answer, and clears it from the snapshot', async () => {
    const registry = new ToolRegistry();
    const { createQuestionTool } = await import('../src/tools/question.js');
    registry.register(createQuestionTool());
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => questionCall('{"question":"Which environment?","options":["Staging","Production"]}'))
        .mockImplementationOnce(async () => fixtureText('Deploying to Staging.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    const run = session.sendMessage({ text: 'deploy', images: [] });

    await vi.waitFor(() => {
      expect(session!.getSnapshot().pendingQuestion).not.toBeNull();
    });
    const pending = session.getSnapshot().pendingQuestion!;
    expect(pending.question).toBe('Which environment?');
    expect(pending.options).toEqual(['Staging', 'Production']);
    expect(session.getSnapshot().busy).toBe(true);

    session.answerQuestion('Staging', pending.id);
    await run;

    const snapshot = session.getSnapshot();
    expect(snapshot.pendingQuestion).toBeNull();
    const tool = snapshot.session.entries.find((entry) => entry.kind === 'tool') as { result: string } | undefined;
    expect(tool?.result).toBe('Staging');
    expect(snapshot.session.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'Deploying to Staging.' });
  });

  it('resolves a dismissed question to null on stop', async () => {
    const registry = new ToolRegistry();
    const { createQuestionTool } = await import('../src/tools/question.js');
    registry.register(createQuestionTool());
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi.fn().mockImplementationOnce(async () => questionCall('{"question":"Proceed?"}')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry));
    const run = session.sendMessage({ text: 'go', images: [] });

    await vi.waitFor(() => {
      expect(session!.getSnapshot().pendingQuestion).not.toBeNull();
    });
    session.stop();
    await run;

    const snapshot = session.getSnapshot();
    expect(snapshot.pendingQuestion).toBeNull();
    expect(snapshot.busy).toBe(false);
  });

  it('reports the question as unavailable in a background session instead of waiting', async () => {
    const registry = new ToolRegistry();
    const { createQuestionTool } = await import('../src/tools/question.js');
    registry.register(createQuestionTool());
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => questionCall('{"question":"Which environment?"}'))
        .mockImplementationOnce(async () => fixtureText('Included the question in the final answer.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, {
      background: true,
      autoApprove: () => true,
    });
    await session.sendMessage({ text: 'deploy', images: [] });

    const snapshot = session.getSnapshot();
    expect(snapshot.pendingQuestion).toBeNull();
    const tool = snapshot.session.entries.find((entry) => entry.kind === 'tool') as { result: string } | undefined;
    expect(tool?.result).toContain('No interactive user is attached');
    expect(snapshot.session.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'Included the question in the final answer.' });
  });
});

describe('session activity reporting', () => {
  it('reports the session running for the whole turn and clears it afterwards', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { isSessionActive, resetSessionActivityForTests } = await import('../src/session-registry.js');
    const { createSession, saveSession } = await import('../src/session-store.js');
    resetSessionActivityForTests();
    saveSession({
      ...createSession('fixture', 'fixture', undefined, process.cwd()),
      entries: [{ kind: 'user', text: 'sibling work' }],
    });

    let captured: unknown;
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async (options) => {
        captured = options;
        return delayedStream([
          { type: 'text-start', id: 'activity' },
          { pause: 50 },
          { type: 'text-delta', id: 'activity', delta: 'Working.' },
          { type: 'text-end', id: 'activity' },
        ]);
      },
    });
    session = new AgentSessionController(runtimeFor(model));
    const id = session.getSnapshot().session.id;

    const run = session.sendMessage({ text: 'Do the work.', images: [] });
    expect(isSessionActive(id)).toBe(true);
    await run;
    expect(isSessionActive(id)).toBe(false);

    // The system prompt carries no live session list, so it stays cacheable.
    const prompt = JSON.stringify(captured);
    expect(prompt).not.toContain('## Recent sessions');
    expect(prompt).not.toContain('sibling work');
  });

  it('keeps queued messages on a keepQueue stop and drops them on a plain stop', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const endless = () => {
      let timer: NodeJS.Timeout | undefined;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'endless' });
            controller.enqueue({ type: 'text-delta', id: 'endless', delta: 'Still working…' });
            timer = setInterval(() => {
              try {
                controller.enqueue({ type: 'text-delta', id: 'endless', delta: '.' });
              } catch {
                if (timer) clearInterval(timer);
              }
            }, 25);
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        }),
      };
    };
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => endless())
        .mockImplementationOnce(async () =>
          delayedStream([
            { type: 'text-start', id: 'third' },
            { type: 'text-delta', id: 'third', delta: 'Third answer.' },
            { type: 'text-end', id: 'third' },
          ]),
        ),
    });
    session = new AgentSessionController(runtimeFor(model));
    void session.sendMessage({ text: 'First request.', images: [] });
    // Wait until the stream is actually flowing so the queued message cannot be drained mid-run.
    await vi.waitFor(() =>
      expect(
        session!.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('Still working')),
      ).toBe(true),
    );
    void session.sendMessage({ text: 'Second request.', images: [] });
    await vi.waitFor(() => expect(session!.getSnapshot().queuedMessageCount).toBe(1));

    session.stop({ keepQueue: true });
    // The aborted run ends and the preserved input starts automatically in a fresh turn.
    await vi.waitFor(() => expect(session!.getSnapshot().busy).toBe(false));
    expect(session.getSnapshot().queuedMessageCount).toBe(0);
    void session.sendMessage({ text: 'Third request.', images: [] });
    await vi.waitFor(() =>
      expect(session!.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Second request.')).toBe(true),
    );
    expect(session.getSnapshot().queuedMessageCount).toBe(0);
    await session.close();
    session = undefined;

    const plainModel = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () => endless())
        .mockImplementationOnce(async () =>
          delayedStream([
            { type: 'text-start', id: 'unused' },
            { type: 'text-delta', id: 'unused', delta: 'Should never run.' },
            { type: 'text-end', id: 'unused' },
          ]),
        ),
    });
    session = new AgentSessionController(runtimeFor(plainModel));
    void session.sendMessage({ text: 'First request.', images: [] });
    await vi.waitFor(() =>
      expect(
        session!.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('Still working')),
      ).toBe(true),
    );
    void session.sendMessage({ text: 'Second request.', images: [] }).catch(() => {});
    await vi.waitFor(() => expect(session!.getSnapshot().queuedMessageCount).toBe(1));

    session.stop();
    await vi.waitFor(() => expect(session!.getSnapshot().busy).toBe(false));
    expect(session.getSnapshot().session.entries.find((entry) => entry.kind === 'user')?.turnOutcome).toBe('cancelled');
    expect(session.getSnapshot().queuedMessageCount).toBe(0);
    expect(session.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Second request.')).toBe(false);
  });

  it('holds queued messages on a holdQueue stop: they land in the chat without starting a run', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    let calls = 0;
    const endless = () => {
      let timer: NodeJS.Timeout | undefined;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'endless' });
            controller.enqueue({ type: 'text-delta', id: 'endless', delta: 'Still working…' });
            timer = setInterval(() => {
              try {
                controller.enqueue({ type: 'text-delta', id: 'endless', delta: '.' });
              } catch {
                if (timer) clearInterval(timer);
              }
            }, 25);
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        }),
      };
    };
    const answer = (id: string, text: string) => async () => {
      calls++;
      if (calls === 1) return endless();
      return delayedStream([
        { type: 'text-start', id },
        { type: 'text-delta', id, delta: text },
        { type: 'text-end', id },
      ]);
    };
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi.fn().mockImplementation(async () => answer(`answer-${calls + 1}`, `Answer ${calls + 1}.`)()),
    });
    session = new AgentSessionController(runtimeFor(model));
    void session.sendMessage({ text: 'First request.', images: [] });
    await vi.waitFor(() =>
      expect(
        session!.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('Still working')),
      ).toBe(true),
    );
    void session.sendMessage({ text: 'Second request.', images: [] });
    await vi.waitFor(() => expect(session!.getSnapshot().queuedMessageCount).toBe(1));

    session.stop({ keepQueue: true, holdQueue: true });
    await vi.waitFor(() => expect(session!.getSnapshot().busy).toBe(false));
    // The Esc contract: the pending message lands in the chat right away, but nothing restarts on its own.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toBe(1);
    expect(session.getSnapshot().queuedMessageCount).toBe(0);
    const heldEntries = () =>
      session!.getSnapshot().session.entries.filter((entry) => entry.kind === 'user' && entry.text === 'Second request.');
    expect(heldEntries()).toHaveLength(1);
    expect(session.getSnapshot().session.entries.find((entry) => entry.kind === 'user')?.turnOutcome).toBe('cancelled');
    expect(heldEntries()[0]!.turnOutcome).toBeUndefined();

    // The next explicit send releases the hold: held and new messages resume in order.
    void session.sendMessage({ text: 'Third request.', images: [] });
    await vi.waitFor(() =>
      expect(session!.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'Third request.')).toBe(true),
    );
    await vi.waitFor(() => expect(session!.getSnapshot().queuedMessageCount).toBe(0));
    // The held message is delivered once, so its transcript entry must not be duplicated.
    expect(heldEntries()).toHaveLength(1);
    await vi.waitFor(() => expect(session!.getSnapshot().busy).toBe(false));
    expect(heldEntries()[0]!.turnOutcome).toBe('completed');
    await session.close();
    session = undefined;
  });

  it('delivers a send that lands in the stop race window without restarting the run', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    let calls = 0;
    const endless = () => {
      let timer: NodeJS.Timeout | undefined;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'endless' });
            controller.enqueue({ type: 'text-delta', id: 'endless', delta: 'Still working' });
            timer = setInterval(() => {
              try {
                controller.enqueue({ type: 'text-delta', id: 'endless', delta: '.' });
              } catch {
                if (timer) clearInterval(timer);
              }
            }, 25);
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        }),
      };
    };
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) return endless();
        return delayedStream([
          { type: 'text-start', id: `answer-${calls}` },
          { type: 'text-delta', id: `answer-${calls}`, delta: `Answer ${calls}.` },
          { type: 'text-end', id: `answer-${calls}` },
        ]);
      }),
    });
    session = new AgentSessionController(runtimeFor(model));
    void session.sendMessage({ text: 'First request.', images: [] });
    await vi.waitFor(() =>
      expect(
        session!.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('Still working')),
      ).toBe(true),
    );
    const users = () => session!.getSnapshot().session.entries.filter((entry) => entry.kind === 'user');

    // The send lands synchronously inside the abort window: the run is still busy.
    session.stop({ keepQueue: true, holdQueue: true });
    void session.sendMessage({ text: 'After stop.', images: [] });

    await vi.waitFor(() => expect(session!.getSnapshot().busy).toBe(false));
    // The Esc contract in the race window: delivered to the chat, no restart, nothing stuck.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toBe(1);
    const after = users().filter((entry) => entry.text === 'After stop.');
    expect(after).toHaveLength(1);
    expect(session.getSnapshot().queuedMessageCount).toBe(0);
    expect(after[0]!.turnOutcome).toBeUndefined();
    // The dying run keeps its own turn while the held message mints a fresh one.
    const firstUser = users().find((entry) => entry.text === 'First request.')!;
    expect(firstUser.turnOutcome).toBe('cancelled');
    expect(after[0]!.turnId).toBeTruthy();
    expect(after[0]!.turnId).not.toBe(firstUser.turnId);
    const assistants = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'assistant');
    expect(assistants.length).toBeGreaterThan(0);
    for (const entry of assistants) expect(entry.turnId).toBe(firstUser.turnId);

    // The next explicit send releases the hold: held and new messages run in order,
    // and the already-materialised entry is delivered exactly once.
    void session.sendMessage({ text: 'Third request.', images: [] });
    await vi.waitFor(() => expect(users().find((entry) => entry.text === 'After stop.')?.turnOutcome).toBe('completed'));
    expect(users().filter((entry) => entry.text === 'After stop.')).toHaveLength(1);
    await vi.waitFor(() => expect(session!.getSnapshot().busy).toBe(false));
    await session.close();
    session = undefined;
  });

  it('keeps a flushed answer under the run turn when a held message follows', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    let calls = 0;
    const endless = () => {
      let timer: NodeJS.Timeout | undefined;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'endless' });
            controller.enqueue({ type: 'text-delta', id: 'endless', delta: 'Still working' });
            timer = setInterval(() => {
              try {
                controller.enqueue({ type: 'text-delta', id: 'endless', delta: '.' });
              } catch {
                if (timer) clearInterval(timer);
              }
            }, 25);
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        }),
      };
    };
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) return endless();
        return delayedStream([
          { type: 'text-start', id: `answer-${calls}` },
          { type: 'text-delta', id: `answer-${calls}`, delta: `Answer ${calls}.` },
          { type: 'text-end', id: `answer-${calls}` },
        ]);
      }),
    });
    session = new AgentSessionController(runtimeFor(model));
    void session.sendMessage({ text: 'First request.', images: [] });
    await vi.waitFor(() =>
      expect(
        session!.getSnapshot().session.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('Still working')),
      ).toBe(true),
    );
    void session.sendMessage({ text: 'Queued before stop.', images: [] }).catch(() => {});
    await vi.waitFor(() => expect(session!.getSnapshot().queuedMessageCount).toBe(1));

    session.stop({ keepQueue: true, holdQueue: true });
    await vi.waitFor(() => expect(session!.getSnapshot().busy).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toBe(1);

    const entries = session.getSnapshot().session.entries;
    const firstUser = entries.find((entry) => entry.kind === 'user' && entry.text === 'First request.')!;
    const held = entries.find((entry) => entry.kind === 'user' && entry.text === 'Queued before stop.')!;
    expect(held).toBeDefined();
    expect(held.turnOutcome).toBeUndefined();
    expect(firstUser.turnOutcome).toBe('cancelled');
    // Flush-first: the answer is finalised under the run's turn before the held
    // message mints a new one, so the held turn holds exactly one entry.
    expect(held.turnId).toBeTruthy();
    expect(held.turnId).not.toBe(firstUser.turnId);
    expect(entries.filter((entry) => entry.turnId === held.turnId)).toHaveLength(1);
    const answer = entries.find((entry) => entry.kind === 'assistant' && entry.text.includes('Still working'))!;
    expect(answer.turnId).toBe(firstUser.turnId);

    await session.close();
    session = undefined;
  });
});

describe('run turn identity at send time', () => {
  it('marks the run busy before the new message reaches the transcript', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    // The answer stream is held open so the run stays busy while the test
    // inspects the snapshots in between; the fixture must not win the race.
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let holdNextRun = false;
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            if (holdNextRun) await runGate;
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'fixture' });
            controller.enqueue({ type: 'text-delta', id: 'fixture', delta: 'Second answer.' });
            controller.enqueue({ type: 'text-end', id: 'fixture' });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: { ...usage, inputTokens: { ...usage.inputTokens, total: 100, noCache: 100 } },
            });
            controller.close();
          },
        }),
      }),
    });
    session = new AgentSessionController(runtimeFor(model));
    await session.sendMessage({ text: 'first message', images: [] });
    expect(session.getSnapshot().busy).toBe(false);
    const entriesBefore = session.getSnapshot().session.entries;
    const lastBefore = entriesBefore[entriesBefore.length - 1];
    holdNextRun = true;
    const run = session.sendMessage({ text: 'second message', images: [] });
    // The queue runner marks the run busy synchronously, but the message's entry
    // only lands after the agent modules load. There is a published window in
    // which the run is busy while the transcript still ends with the previous
    // turn - the window that made a client guess the wrong live turn.
    const started = session.getSnapshot();
    expect(started.busy).toBe(true);
    // The window must name no turn: lighting one here would be a guess, and the
    // previous turn is what the reader just finished reading.
    expect(started.runningTurnId).toBeNull();
    expect(started.session.entries.some((entry) => entry.kind === 'user' && entry.text === 'second message')).toBe(false);
    expect(started.session.entries[started.session.entries.length - 1]).toBe(lastBefore);
    // Once the message reaches the transcript, the snapshot names that turn.
    await vi.waitFor(() =>
      expect(session!.getSnapshot().session.entries.some((entry) => entry.kind === 'user' && entry.text === 'second message')).toBe(true),
    );
    const running = session.getSnapshot();
    expect(running.busy).toBe(true);
    const secondEntry = running.session.entries.find((entry) => entry.kind === 'user' && entry.text === 'second message')!;
    expect(secondEntry.turnId).toBeDefined();
    expect(running.runningTurnId).toBe(secondEntry.turnId);
    releaseRun();
    await run;
    const settled = session.getSnapshot();
    expect(settled.busy).toBe(false);
    expect(settled.runningTurnId).toBeNull();
  });

  it('names the turn a standalone compaction writes into', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () => fixtureText('Checkpoint: the fixture conversation is condensed.'),
    });
    session = new AgentSessionController(runtimeFor(model));
    await session.sendMessage({ text: 'first message', images: [] });
    const userEntry = session.getSnapshot().session.entries.find((entry) => entry.kind === 'user')!;
    expect(userEntry.turnId).toBeDefined();
    const compaction = session.compact();
    // compact() marks the run busy synchronously; the compaction row lands in
    // the turn the transcript already ends in, but a standalone compaction is
    // a boundary, never a running turn: reporting one here re-opened the
    // finished turn in the client and started its timer again.
    const started = session.getSnapshot();
    expect(started.busy).toBe(true);
    expect(started.runningTurnId).toBeNull();
    await compaction;
    const settled = session.getSnapshot();
    expect(settled.busy).toBe(false);
    expect(settled.runningTurnId).toBeNull();
    // The rows and the checkpoint name that turn as well: placement by array
    // position alone is what let a message sent during the compaction claim them.
    const rows = settled.session.entries.filter((entry) => entry.kind === 'compaction');
    expect(rows.map((entry) => entry.turnId)).toEqual([userEntry.turnId]);
    const checkpoint = settled.session.entries.filter((entry) => entry.kind === 'assistant').at(-1);
    expect(checkpoint?.text).toContain('Checkpoint');
    expect(checkpoint?.turnId).toBe(userEntry.turnId);
  });
});

describe('stored transcript migration', () => {
  it('restores the compaction marker the old restore path dropped, once, on load', async () => {
    const { createSession, saveSession } = await import('../src/session-store.js');
    const { AgentSessionController } = await import('../src/agent-session.js');
    const saved = saveSession({
      ...createSession('fixture', 'fixture', undefined, process.cwd()),
      entries: [
        { kind: 'user', text: 'Task' },
        { kind: 'compaction', status: 'done' },
        // The duration rebuild dropped the marker: exactly what old files hold.
        { kind: 'reasoning', text: 'Checkpoint thinking', durationMs: 1_000 },
        { kind: 'assistant', text: '## Objective and current request', internal: 'compaction' },
        { kind: 'reasoning', text: 'Run thinking', durationMs: 500 },
      ],
    });
    const model = new MockLanguageModelV3({ doGenerate: async () => titleResponse(), doStream: async () => fixtureText('ok') });
    session = new AgentSessionController(runtimeFor(model));
    await session.loadSession(saved.id);
    const reasoning = session.getSnapshot().session.entries.filter((entry) => entry.kind === 'reasoning');
    expect(reasoning.map((entry) => entry.internal)).toEqual(['compaction', undefined]);
    expect(reasoning.map((entry) => entry.text)).toEqual(['Checkpoint thinking', 'Run thinking']);
  });
});

describe('stored transcript dividers', () => {
  function dividerModel() {
    return new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () => fixtureText('Completed answer'),
    });
  }

  const dividersOf = (session: AgentSessionController, prefix: string | RegExp) =>
    session
      .getSnapshot()
      .session.entries.filter(
        (entry): entry is Extract<SessionEntry, { kind: 'divider' }> =>
          entry.kind === 'divider' &&
          entry.text !== undefined &&
          (typeof prefix === 'string' ? entry.text.startsWith(prefix) : prefix.test(entry.text)),
      );

  const dayDividersOf = (session: AgentSessionController) =>
    session
      .getSnapshot()
      .session.entries.filter(
        (entry): entry is Extract<SessionEntry, { kind: 'divider' }> => entry.kind === 'divider' && entry.text === undefined,
      );

  it('opens a new chat with no day divider and separates only a later day', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(dividerModel()));
    await session.sendMessage({ text: 'First message', images: [] });
    await session.waitUntilIdle(1000);
    // Nothing stood above the first message, so there was no boundary to draw.
    expect(dayDividersOf(session)).toHaveLength(0);

    await session.sendMessage({ text: 'Second message', images: [] });
    await session.waitUntilIdle(1000);
    expect(dayDividersOf(session)).toHaveLength(0);

    // With an entry from an earlier day in place, the break returns above the next message.
    session.addEntry({ kind: 'notice', text: 'archived earlier', at: Date.now() - 2 * 86_400_000 });
    await session.sendMessage({ text: 'Back after a gap', images: [] });
    await session.waitUntilIdle(1000);
    const dayDividers = dayDividersOf(session);
    expect(dayDividers).toHaveLength(1);

    const entries = session.getSnapshot().session.entries;
    const users = entries.filter((entry) => entry.kind === 'user');
    const dividerIndex = entries.indexOf(dayDividers[0]!);
    expect(dividerIndex).toBeLessThan(entries.indexOf(users[users.length - 1]!));
    expect(dividerIndex + 1).toBe(entries.indexOf(users[users.length - 1]!));
  });

  it('writes a fresh day divider when the last entry belongs to an earlier day', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(dividerModel()));
    session.addEntry({ kind: 'notice', text: 'archived earlier', at: Date.now() - 2 * 86_400_000 });
    await session.sendMessage({ text: 'Back after a gap', images: [] });
    await session.waitUntilIdle(1000);
    const dayDividers = dayDividersOf(session);
    expect(dayDividers).toHaveLength(1);
    const entries = session.getSnapshot().session.entries;
    expect(entries.indexOf(dayDividers[0]!)).toBeLessThan(entries.findIndex((entry) => entry.kind === 'user'));
  });

  it('announces an idle effort change once, above the message that will use it', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const runtime = runtimeFor(dividerModel());
    session = new AgentSessionController(runtime);
    await session.sendMessage({ text: 'Baseline', images: [] });
    await session.waitUntilIdle(1000);
    expect(dividersOf(session, 'Reasoning effort')).toHaveLength(0);

    // The machine default a chat inherits is the RAW preference; the chat
    // resolves it against its own levels.
    runtime.reasoningPreference = 'high';
    await session.sendMessage({ text: 'Uses the new effort', images: [] });
    await session.waitUntilIdle(1000);
    const effort = dividersOf(session, 'Reasoning effort');
    expect(effort).toHaveLength(1);
    expect(effort[0]!.text).toBe('Reasoning effort changed from "default" to "high"');

    await session.sendMessage({ text: 'Quiet again', images: [] });
    await session.waitUntilIdle(1000);
    expect(dividersOf(session, 'Reasoning effort')).toHaveLength(1);

    const entries = session.getSnapshot().session.entries;
    const effortIndex = entries.indexOf(effort[0]!);
    const users = entries.filter((entry) => entry.kind === 'user');
    expect(effortIndex).toBeLessThan(entries.indexOf(users[1]!));
    expect(effortIndex).toBeGreaterThan(entries.indexOf(users[0]!));
  });

  it('holds a model switch out of the transcript until a message runs with it', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    // A runtime that can be rebound: a real one restores the session model at the
    // turn boundary, and the fixture's bare runtime cannot, which would fail the
    // turn before its message ever reaches the transcript.
    const runtime = runtimeFor(dividerModel());
    runtime.restoreModel = async () => {};
    session = new AgentSessionController(runtime);
    await session.sendMessage({ text: 'First message', images: [] });
    await session.waitUntilIdle(1000);

    await session.selectModel('other', 'other-model');
    // A pick is a choice, not a message: nothing has run under it yet.
    expect(dividersOf(session, 'Model changed')).toHaveLength(0);

    await session.selectModel('other', 'other-model');
    expect(dividersOf(session, 'Model changed')).toHaveLength(0);

    await session.sendMessage({ text: 'Runs under the new model', images: [] });
    await session.waitUntilIdle(1000);
    const model = dividersOf(session, 'Model changed');
    expect(model).toHaveLength(1);
    expect(model[0]!.text).toBe('Model changed from "fixture" to "other-model"');

    await session.sendMessage({ text: 'Still the new model', images: [] });
    await session.waitUntilIdle(1000);
    expect(dividersOf(session, 'Model changed')).toHaveLength(1);
  });
});

describe('session-owned reasoning', () => {
  it('records the owner effort on this session and makes it the turn authority', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const runtime = runtimeFor(
      new MockLanguageModelV3({
        doGenerate: async () => titleResponse(),
        doStream: async () => fixtureText('Runs on the session choice'),
      }),
    );
    const seen: string[] = [];
    runtime.getReasoningProviderOptions = (variantId: string) => {
      seen.push(variantId);
      return {};
    };
    session = new AgentSessionController(runtime);
    session.setReasoningPreference('high');
    expect(session.getSnapshot().session.reasoning).toBe('high');

    // The message carries another effort: the session still wins, and the
    // machine default in the runtime is never written.
    await session.sendMessage({ text: 'Uses the session choice', images: [] });
    await session.waitUntilIdle(1000);
    expect(seen[0]).toBe('high');
    expect(runtime.reasoningDefault).toBe('default');

    // The choice survives a save and reload of the chat.
    const { loadSavedSession } = await import('../src/session-store.js');
    await session.flushSave();
    const saved = loadSavedSession(session.getSnapshot().session.id);
    expect(saved?.reasoning).toBe('high');
  });

  it('keeps following the machine default while the session never chose', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const runtime = runtimeFor(
      new MockLanguageModelV3({
        doGenerate: async () => titleResponse(),
        doStream: async () => fixtureText('Runs on the default'),
      }),
    );
    const seen: string[] = [];
    runtime.getReasoningProviderOptions = (variantId: string) => {
      seen.push(variantId);
      return {};
    };
    session = new AgentSessionController(runtime);
    await session.sendMessage({ text: 'No choice made', images: [] });
    await session.waitUntilIdle(1000);
    expect(seen[0]).toBe('default');
    expect(session.getSnapshot().session.reasoning).toBeUndefined();
    expect(session.getSnapshot().session.showReasoning).toBeUndefined();
  });

  it('opens a new chat on the effort the current chat is using', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(
      runtimeFor(
        new MockLanguageModelV3({
          doGenerate: async () => titleResponse(),
          doStream: async () => fixtureText('New chat'),
        }),
      ),
    );
    session.setReasoningPreference('high');
    session.setShowReasoningPreference(false);
    const previousId = session.getSnapshot().session.id;
    await session.createNewSession();
    expect(session.getSnapshot().session.id).not.toBe(previousId);
    expect(session.getSnapshot().session.reasoning).toBe('high');
    expect(session.getSnapshot().session.showReasoning).toBe(false);
  });

  it('shows a running turn one bounded report line, as a projection and not as a message', async () => {
    let pendingLine: string | null = null;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        started = true;
        await gate;
        return { message: 'Evidence' };
      },
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          delayedStream([{ type: 'tool-call', toolCallId: 'one', toolName: 'inspect', input: '{}' }], 'tool-calls'),
        )
        .mockImplementationOnce(async () => fixtureText('Finished with the report in view.')),
    });
    const { AgentSessionController } = await import('../src/agent-session.js');
    session = new AgentSessionController(runtimeFor(model, registry), undefined, {
      sessionWorkspaceRoot: null,
      pendingReports: () => pendingLine,
    });
    const turn = session.sendMessage({ text: 'Owner task.', images: [] });
    await vi.waitFor(() => expect(started).toBe(true));
    // The report lands while the turn is waiting on a tool, so only the next step can see it.
    pendingLine = '[Host context: 1 report waiting from below - a1b2c3d4 "Refactor": 1 result. Read them with inbox.]';
    release();
    await turn;
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).not.toContain('waiting from below');
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain('waiting from below');
    // A projection: the line never becomes a chat entry the owner would read.
    const entries = session.getSnapshot().session.entries;
    expect(entries.some((entry) => 'text' in entry && typeof entry.text === 'string' && entry.text.includes('waiting from below'))).toBe(
      false,
    );
  });
});

describe('model and effort persistence', () => {
  it('keeps a choice made on a chat that has no message yet', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { loadSavedSession, listSavedSessions } = await import('../src/session-store.js');
    const runtime = runtimeFor(new MockLanguageModelV3({ doGenerate: async () => titleResponse() }));
    runtime.selectModel = async (providerId, modelId) => {
      runtime.providerId = providerId;
      runtime.modelId = modelId;
      runtime.reasoningVariants = [
        { id: 'default', label: 'Default', providerOptions: {} },
        { id: 'high', label: 'High', providerOptions: {} },
      ];
    };
    session = new AgentSessionController(runtime);
    const id = session.getSnapshot().session.id;

    await session.selectModel('second-endpoint', 'second-model');
    session.setReasoningPreference('high');
    await session.flushSave();

    const saved = loadSavedSession(id);
    expect(saved).not.toBeNull();
    expect(saved!.providerId).toBe('second-endpoint');
    expect(saved!.modelId).toBe('second-model');
    expect(saved!.reasoning).toBe('high');
    expect(saved!.reasoningVariants?.map((variant) => variant.id)).toEqual(['default', 'high']);
    // The record exists only because the choice moved; a chat with no message still
    // never surfaces in the picker.
    expect(listSavedSessions().map((entry) => entry.id)).not.toContain(id);
  });

  it('writes nothing for a chat whose choice never moved', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const { loadSavedSession } = await import('../src/session-store.js');
    session = new AgentSessionController(runtimeFor(new MockLanguageModelV3({ doGenerate: async () => titleResponse() })));
    const id = session.getSnapshot().session.id;

    await session.flushSave();

    expect(loadSavedSession(id)).toBeNull();
  });
});
