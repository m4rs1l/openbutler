import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEnvironment, AgentSessionController } from '../src/agent-session.js';
import type { SessionEntry } from '../src/session-store.js';
import { ToolRegistry } from '../src/tools/registry.js';

/**
 * The behaviour the owner asked for, as a test.
 *
 * A model or effort picked while a run is going belongs to the NEXT turn: the
 * running turn keeps what it was admitted with, the pick lands at the turn
 * boundary, and the transcript marks the change above the message that uses it.
 */

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
    // The title run gets its own model and options, so the effort counter below
    // only sees the requests the turn itself made.
    titleModel: model,
    getTitleProviderOptions: () => ({}),
    workspaceRoot: process.cwd(),
    modelName: 'Local streaming fixture',
    providerId: 'fixture',
    modelId: 'fixture',
    contextWindowTokens: null,
    outputLimitTokens: null,
    supportsVision: false,
    supportsImageToolResult: true,
    reasoningVariants: [
      { id: 'default', label: 'Default', providerOptions: {} },
      { id: 'low', label: 'Low', providerOptions: {} },
      { id: 'high', label: 'High', providerOptions: {} },
    ],
    reasoningMetadataSource: null,
    reasoningSupport: 'available',
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

let dataDir: string;
let previousDataDir: string | undefined;
let session: AgentSessionController | undefined;

beforeEach(() => {
  previousDataDir = process.env.OPENBUTLER_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'openbutler-turn-boundary-'));
  process.env.OPENBUTLER_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  if (previousDataDir === undefined) delete process.env.OPENBUTLER_DATA_DIR;
  else process.env.OPENBUTLER_DATA_DIR = previousDataDir;
  if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith('openbutler-turn-boundary-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const dividersOf = (target: AgentSessionController, prefix: string) =>
  target
    .getSnapshot()
    .session.entries.filter(
      (entry): entry is Extract<SessionEntry, { kind: 'divider' }> =>
        entry.kind === 'divider' && entry.text !== undefined && entry.text.startsWith(prefix),
    );

/** A gate the test opens by hand, so a turn can be held open on purpose. */
function makeGate() {
  let open: () => void = () => {};
  const promise = new Promise((resolve) => {
    open = () => resolve(undefined);
  });
  return { promise, open: () => open() };
}

describe('a model or effort picked during a run belongs to the next turn', () => {
  it('runs the busy turn with the old model and takes the pick up at the next message', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const gate = makeGate();
    let started = false;
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () => {
        started = true;
        await gate.promise;
        return fixtureText('Completed answer');
      },
    });
    const otherModel = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () => fixtureText('Answer under the other model'),
    });
    const runtime = runtimeFor(model);
    const activated: string[] = [];
    const restored: string[] = [];
    runtime.selectModel = async (providerId, modelId) => {
      activated.push(modelId);
      runtime.providerId = providerId;
      runtime.modelId = modelId;
    };
    runtime.restoreModel = async (providerId, modelId) => {
      restored.push(modelId);
      runtime.providerId = providerId;
      runtime.modelId = modelId;
    };
    // The runtime builds one state per (provider, model) pair, the shape
    // the real runtime has: a chat asks for the state of the model it wants.
    runtime.modelFor = async (providerId, modelId) => ({
      providerId,
      modelId,
      modelName: modelId,
      providerName: providerId,
      model: modelId === 'other-model' ? otherModel : model,
      contextWindowTokens: null,
      outputLimitTokens: null,
      supportsVision: false,
      supportsImageToolResult: true,
      reasoningVariants: runtime.reasoningVariants,
      reasoningTitles: false,
      reasoningMetadataSource: null,
      reasoningSupport: 'available' as const,
      getReasoningProviderOptions: () => ({}),
      registry: runtime.registry,
    });
    session = new AgentSessionController(runtime);

    const turn = session.sendMessage({ text: 'Runs under the old model', images: [] });
    await vi.waitFor(() => expect(started).toBe(true));

    // The pick is accepted while the run is going.
    await session.selectModel('other', 'other-model', [
      { id: 'default', label: 'Default' },
      { id: 'high', label: 'High' },
    ]);
    expect(session.getSnapshot().session.modelId).toBe('other-model');
    // The shared runtime did not move under the running turn.
    expect(activated).toEqual([]);
    expect(restored).toEqual([]);

    gate.open();
    await turn;
    await session.waitUntilIdle(1000);
    expect(runtime.modelId).toBe('fixture');

    // The next message runs with the picked model, and the transcript says so.
    await session.sendMessage({ text: 'Runs under the new model', images: [] });
    await session.waitUntilIdle(1000);
    // The picked model ran the turn...
    expect(otherModel.doStreamCalls.length).toBeGreaterThan(0);
    // ...and the shared runtime never moved: a chat asks for a model state,
    // it does not rebind the runtime that other chats share.
    expect(activated).toEqual([]);
    expect(restored).toEqual([]);
    expect(runtime.modelId).toBe('fixture');
    const changed = dividersOf(session, 'Model changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.text).toBe('Model changed from "fixture" to "other-model"');
  });

  it('keeps the running turn on its effort and applies the changed one to the next turn', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const registry = new ToolRegistry();
    registry.register({
      providerId: 'host',
      name: 'inspect',
      description: 'Fixture',
      inputSchema: { type: 'object', properties: {} },
      effect: { change: 'none', data: 'local', network: 'none', reversible: 'full', outbound: 'model' },
      autoApprove: () => true,
      execute: async () => {
        // The owner changes the effort while this turn is still running.
        session!.setReasoningPreference('low');
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
        .mockImplementationOnce(async () => fixtureText('Finished under the admitted effort.')),
    });
    const runtime = runtimeFor(model, registry);
    const seen: string[] = [];
    runtime.getReasoningProviderOptions = (variantId: string) => {
      seen.push(variantId);
      return {};
    };
    session = new AgentSessionController(runtime);
    session.setReasoningPreference('high');

    await session.sendMessage({ text: 'Runs under the admitted effort', images: [] });
    await session.waitUntilIdle(1000);
    // Both steps of the running turn used the effort the turn was admitted with.
    expect(seen).toEqual(['high', 'high']);
    expect(session.getSnapshot().session.reasoning).toBe('low');
    // The level the chat leaves behind is no longer offered by the next model:
    // the divider must still name it the way it was announced.
    runtime.reasoningVariants = [
      { id: 'default', label: 'Default', providerOptions: {} },
      { id: 'low', label: 'Low', providerOptions: {} },
    ];

    // The next turn takes the new effort, and the transcript marks the change.
    await session.sendMessage({ text: 'Runs under the new effort', images: [] });
    await session.waitUntilIdle(1000);
    expect(seen).toEqual(['high', 'high', 'low']);
    const changed = dividersOf(session, 'Reasoning effort');
    // The pick made before the first message is marked as well, and the change
    // made during the run is marked at the boundary it takes effect in.
    expect(changed.map((entry) => entry.text)).toEqual([
      'Reasoning effort changed from "Default" to "High"',
      'Reasoning effort changed from "High" to "Low"',
    ]);
  });

  it('marks an idle model pick above the next message', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () => fixtureText('Completed answer'),
    });
    const runtime = runtimeFor(model);
    runtime.restoreModel = async (providerId, modelId) => {
      runtime.providerId = providerId;
      runtime.modelId = modelId;
    };
    session = new AgentSessionController(runtime);

    await session.sendMessage({ text: 'Baseline', images: [] });
    await session.waitUntilIdle(1000);
    expect(dividersOf(session, 'Model changed')).toHaveLength(0);

    await session.selectModel('other', 'other-model', [
      { id: 'default', label: 'Default' },
      { id: 'high', label: 'High' },
    ]);
    // A pick is a choice, not a message: nothing has run under it yet.
    expect(dividersOf(session, 'Model changed')).toHaveLength(0);

    await session.sendMessage({ text: 'Runs under the new model', images: [] });
    await session.waitUntilIdle(1000);
    const changed = dividersOf(session, 'Model changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.text).toBe('Model changed from "fixture" to "other-model"');
  });

  it('marks an idle effort pick above the next message', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () => fixtureText('Completed answer'),
    });
    const runtime = runtimeFor(model);
    const seen: string[] = [];
    runtime.getReasoningProviderOptions = (variantId: string) => {
      seen.push(variantId);
      return {};
    };
    session = new AgentSessionController(runtime);

    await session.sendMessage({ text: 'Baseline', images: [] });
    await session.waitUntilIdle(1000);
    expect(dividersOf(session, 'Reasoning effort')).toHaveLength(0);

    session.setReasoningPreference('high');
    await session.sendMessage({ text: 'Runs under the new effort', images: [] });
    await session.waitUntilIdle(1000);
    expect(seen).toEqual(['default', 'high']);
    const changed = dividersOf(session, 'Reasoning effort');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.text).toBe('Reasoning effort changed from "Default" to "High"');
  });

  it('marks an effort picked before the first message above that message', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () => fixtureText('Completed answer'),
    });
    const runtime = runtimeFor(model);
    const seen: string[] = [];
    runtime.getReasoningProviderOptions = (variantId: string) => {
      seen.push(variantId);
      return {};
    };
    session = new AgentSessionController(runtime);

    // The chat has not said anything yet: the pick is made on an empty chat.
    session.setReasoningPreference('high');
    expect(dividersOf(session, 'Reasoning effort')).toHaveLength(0);

    await session.sendMessage({ text: 'First message', images: [] });
    await session.waitUntilIdle(1000);
    // The first message already runs with the picked effort.
    expect(seen).toEqual(['high']);
    const changed = dividersOf(session, 'Reasoning effort');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.text).toBe('Reasoning effort changed from "Default" to "High"');
  });

  it('marks a model picked before the first message above that message', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const model = new MockLanguageModelV3({
      doGenerate: async () => titleResponse(),
      doStream: async () => fixtureText('Completed answer'),
    });
    const runtime = runtimeFor(model);
    runtime.restoreModel = async (providerId, modelId) => {
      runtime.providerId = providerId;
      runtime.modelId = modelId;
    };
    session = new AgentSessionController(runtime);

    await session.selectModel('other', 'other-model', [
      { id: 'default', label: 'Default' },
      { id: 'high', label: 'High' },
    ]);
    expect(dividersOf(session, 'Model changed')).toHaveLength(0);

    await session.sendMessage({ text: 'First message', images: [] });
    await session.waitUntilIdle(1000);
    const changed = dividersOf(session, 'Model changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.text).toBe('Model changed from "fixture" to "other-model"');
  });
});
