import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelEffortProvider } from '../src/provider/model-view.js';

/**
 * The effort list a picker shows for a model the owner has selected but has not
 * switched to. The lookup must answer from the model id alone: a provider id the
 * catalog has never heard of is the normal case for a gateway-style endpoint, and
 * an empty answer there is what makes the web surface offer the wrong levels.
 */
let root: string;
let view: typeof import('../src/provider/model-view.js');

const gateway: ModelEffortProvider = { keys: ['k'], npm: '@ai-sdk/gateway' };
const compatible: ModelEffortProvider = { keys: ['k'], npm: '@ai-sdk/openai-compatible' };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'openbutler-model-view-'));
  vi.stubEnv('OPENBUTLER_DATA_DIR', root);
  vi.resetModules();
  const catalog = await import('../src/provider/catalog.js');
  // Two providers carry the same gateway-style model id, so a lookup issued under
  // a third, catalog-unknown provider id can still find the model.
  catalog.writeCatalogSnapshot(
    {
      'gateway-fixture': {
        npm: '@ai-sdk/gateway',
        models: {
          modelx: {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
            limit: { context: 100_000 },
          },
        },
      },
      'other-gateway': {
        npm: '@ai-sdk/gateway',
        models: { modelx: { reasoning: false, limit: { context: 100_000 } } },
      },
    },
    new Date().toISOString(),
  );
  view = await import('../src/provider/model-view.js');
});

afterAll(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('openbutler-model-view-')) {
    throw new Error('Unsafe model-view fixture cleanup path.');
  }
  rmSync(root, { recursive: true, force: true });
});

describe('describeModelReasoning', () => {
  it('answers for a configured model before anything activates it', () => {
    const described = view.describeModelReasoning('fixture', 'modelx', gateway, 'high');
    expect(described).not.toBeNull();
    expect(described!.variants.map((variant) => variant.id)).toEqual(['default', 'low', 'high']);
    expect(described!.defaultVariantId).toBe('high');
  });

  it('finds the model under a provider id the catalog does not carry', () => {
    // `custom-gateway` is not in models.dev at all; only the model id identifies it.
    const described = view.describeModelReasoning('custom-gateway', 'modelx', compatible);
    expect(described).not.toBeNull();
    expect(described!.variants.map((variant) => variant.id)).toEqual(['default', 'low', 'high']);
  });

  it('prefers the provider that declares reasoning metadata when several carry the id', () => {
    // `other-gateway` mirrors the id without reasoning options; the entry that
    // describes the levels must win over the mirror.
    const described = view.describeModelReasoning('custom-gateway', 'modelx', gateway);
    expect(described!.variants.map((variant) => variant.id)).toEqual(['default', 'low', 'high']);
  });

  it('appends the efforts settings declares for the model', () => {
    const described = view.describeModelReasoning('fixture', 'modelx', {
      ...gateway,
      modelSpecs: { modelx: { reasoning: { efforts: ['max'] } } },
    });
    expect(described!.variants.map((variant) => variant.id)).toEqual(['default', 'low', 'high', 'max']);
    expect(described!.variants.at(-1)!.label.length).toBeGreaterThan(0);
  });

  it('returns null when nothing can authenticate the provider', () => {
    expect(view.describeModelReasoning('fixture', 'modelx', {})).toBeNull();
    // The npm package alone is not a credential: on a machine that happens to
    // carry a key in its environment this must still refuse, or the picker would
    // promise levels a provider the owner never configured could take.
    const previousOpenAI = process.env.OPENAI_API_KEY;
    const previousGeneric = process.env.OPENBUTLER_API_KEY;
    process.env.OPENAI_API_KEY = '';
    process.env.OPENBUTLER_API_KEY = '';
    try {
      expect(view.describeModelReasoning('fixture', 'modelx', { npm: '@ai-sdk/gateway' })).toBeNull();
    } finally {
      if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAI;
      if (previousGeneric === undefined) delete process.env.OPENBUTLER_API_KEY;
      else process.env.OPENBUTLER_API_KEY = previousGeneric;
    }
  });

  it('always reports a default that exists in the list it returned', () => {
    for (const preferred of ['high', 'bogus', undefined]) {
      const described = view.describeModelReasoning('fixture', 'modelx', gateway, preferred);
      expect(described).not.toBeNull();
      expect(described!.variants.map((variant) => variant.id)).toContain(described!.defaultVariantId);
    }
  });

  it('keeps a usable list for a model the catalog does not know at all', () => {
    const described = view.describeModelReasoning('fixture', 'uncatalogued', gateway);
    expect(described).not.toBeNull();
    expect(described!.variants.length).toBeGreaterThan(0);
    expect(described!.variants.map((variant) => variant.id)).toContain(described!.defaultVariantId);
  });
});
