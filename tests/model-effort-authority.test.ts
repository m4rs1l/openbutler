import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart, LanguageModelV3StreamResult } from '@ai-sdk/provider';
import type { AgentEnvironment, AgentSessionController } from '../src/agent-session.js';
import { ToolRegistry } from '../src/tools/registry.js';

/**
 * The effort a chat runs with must have exactly one authority, and a stored
 * effort must never cost more than the owner asked for.
 *
 * Two rules are pinned here:
 *
 * 1. A stored effort the model does not offer is degraded, never escalated.
 *    The machine default in settings.yaml says "minimal"; the strongest level
 *    a model offers is "max". Resolving the stale id to the strongest turns
 *    the cheapest intent into the most expensive request.
 * 2. A chat's own choice belongs to the chat. Changing the model re-maps that
 *    choice onto the new model's levels; it never deletes it, because a
 *    deleted choice falls back to the machine default and the chat silently
 *    changes how it runs.
 */

/** The effort levels a model can offer, cheapest first; "default" is the cheapest. */
const EFFORT_LADDER = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function variant(id: string) {
  return { id, label: id.charAt(0).toUpperCase() + id.slice(1), providerOptions: {} };
}

function delayedStream(steps: LanguageModelV3StreamPart[], finishReason: 'stop' | 'length' = 'stop') {
  return {
    stream: new ReadableStream({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        for (const step of steps) controller.enqueue(step);
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: finishReason, raw: finishReason },
          usage,
        });
        controller.close();
      },
    }),
  } satisfies LanguageModelV3StreamResult;
}

function fixtureText(text: string) {
  return delayedStream([
    { type: 'text-start', id: 'fixture' },
    { type: 'text-delta', id: 'fixture', delta: text },
    { type: 'text-end', id: 'fixture' },
  ]);
}

function titleResponse() {
  return {
    content: [{ type: 'text' as const, text: '{"title":"Fixture greeting"}' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' as const },
    usage,
    warnings: [],
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

let dataDir: string;
let previousDataDir: string | undefined;
let session: AgentSessionController | undefined;

beforeEach(() => {
  previousDataDir = process.env.OPENBUTLER_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'openbutler-model-effort-authority-'));
  process.env.OPENBUTLER_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  session = undefined;
  if (previousDataDir === undefined) delete process.env.OPENBUTLER_DATA_DIR;
  else process.env.OPENBUTLER_DATA_DIR = previousDataDir;
  if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith('openbutler-model-effort-authority-')) {
    throw new Error('Refusing to remove a directory outside this test fixture.');
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a stored effort never costs more than the owner asked for', () => {
  it('degrades a stored effort the model does not offer instead of escalating it', async () => {
    const { resolveReasoningVariant } = await import('../src/provider/registry.js');
    const variants = ['default', 'low', 'medium', 'high', 'xhigh', 'max'].map(variant);

    // The machine default on this machine is "minimal"; no model offers it.
    const resolved = resolveReasoningVariant(variants, 'minimal');
    const stored = EFFORT_LADDER.indexOf('minimal');
    const got = EFFORT_LADDER.indexOf(resolved.id);
    expect(got, `'minimal' must not resolve to '${resolved.id}'`).toBeGreaterThanOrEqual(0);
    expect(got, `'minimal' must not resolve to '${resolved.id}'`).toBeLessThanOrEqual(stored);

    // The same rule for a level that sits between two offered ones.
    const withoutXhigh = ['default', 'low', 'medium', 'high', 'max'].map(variant);
    expect(resolveReasoningVariant(withoutXhigh, 'xhigh').id).toBe('high');
  });

  it('resolves the machine default against the ladder of the model that runs', async () => {
    // The machine default is a raw id. The runtime resolves it against ITS
    // OWN model, so the value it publishes belongs to that model's ladder.
    // A chat that inherits the default must resolve the RAW id against its
    // own ladder, or the first model's ladder silently demotes it.
    const { resolveReasoningVariant } = await import('../src/provider/registry.js');
    const runtimeModel = ['default', 'low', 'medium', 'high'].map(variant);
    const chatModel = ['default', 'minimal', 'low', 'medium'].map(variant);

    // The runtime's model does not offer "minimal", so it degrades it.
    const published = resolveReasoningVariant(runtimeModel, 'minimal').id;
    expect(published).not.toBe('minimal');

    // The chat's model DOES offer it, so inheriting the machine default must
    // keep it. Resolving the published value instead would lose it.
    const inherited = resolveReasoningVariant(chatModel, 'minimal').id;
    expect(inherited).toBe('minimal');
  });

  it('keeps a listed effort exactly as stored', async () => {
    const { resolveReasoningVariant } = await import('../src/provider/registry.js');
    const variants = ['default', 'low', 'medium', 'high', 'xhigh', 'max'].map(variant);
    expect(resolveReasoningVariant(variants, 'medium').id).toBe('medium');
  });
});

describe('a chat keeps its own effort across a model change', () => {
  it('re-maps the chat effort onto the new model instead of dropping it', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const runtime = runtimeFor(
      new MockLanguageModelV3({
        doGenerate: async () => titleResponse(),
        doStream: async () => fixtureText('Runs on the chat effort'),
      }),
    );
    runtime.reasoningVariants = ['default', 'low', 'medium', 'high'].map(variant);
    runtime.selectModel = async (providerId, modelId) => {
      runtime.providerId = providerId;
      runtime.modelId = modelId;
      // The new model offers no "medium"; "low" is the nearest level below it.
      runtime.reasoningVariants = ['default', 'low'].map(variant);
    };
    session = new AgentSessionController(runtime);
    session.setReasoningPreference('medium');

    await session.selectModel('second-endpoint', 'second-model');

    expect(session.getSnapshot().session.reasoning).toBe('low');
  });

  it('runs the next request with the re-mapped effort, not with the machine default', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const runtime = runtimeFor(
      new MockLanguageModelV3({
        doGenerate: async () => titleResponse(),
        doStream: async () => fixtureText('Runs on the chat effort'),
      }),
    );
    const seen: string[] = [];
    runtime.getReasoningProviderOptions = (variantId: string) => {
      seen.push(variantId);
      return {};
    };
    runtime.reasoningVariants = ['default', 'low', 'medium', 'high'].map(variant);
    runtime.selectModel = async (providerId, modelId) => {
      runtime.providerId = providerId;
      runtime.modelId = modelId;
      runtime.reasoningVariants = ['default', 'low'].map(variant);
    };
    session = new AgentSessionController(runtime);
    session.setReasoningPreference('medium');

    await session.selectModel('second-endpoint', 'second-model');
    await session.sendMessage({ text: 'Uses the chat effort', images: [] });
    await session.waitUntilIdle(1000);

    // The machine default is "default"; the chat chose "medium" and the new
    // model offers "low". The request must run on the chat's own choice.
    expect(seen[0]).toBe('low');
  });

  it('leaves the chat effort alone when the new model still offers it', async () => {
    const { AgentSessionController } = await import('../src/agent-session.js');
    const runtime = runtimeFor(
      new MockLanguageModelV3({
        doGenerate: async () => titleResponse(),
        doStream: async () => fixtureText('Runs on the chat effort'),
      }),
    );
    runtime.reasoningVariants = ['default', 'low', 'medium', 'high'].map(variant);
    runtime.selectModel = async (providerId, modelId) => {
      runtime.providerId = providerId;
      runtime.modelId = modelId;
      runtime.reasoningVariants = ['default', 'low', 'medium', 'high'].map(variant);
    };
    session = new AgentSessionController(runtime);
    session.setReasoningPreference('medium');

    await session.selectModel('second-endpoint', 'second-model');

    expect(session.getSnapshot().session.reasoning).toBe('medium');
  });
});
