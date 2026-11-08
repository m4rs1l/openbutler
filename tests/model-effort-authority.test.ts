import { describe, expect, it } from 'vitest';

/**
 * A stored effort must never cost more than the owner asked for.
 *
 * The machine default in settings.yaml says "minimal"; the strongest level a
 * model offers is "max". Resolving a stale id to the strongest offered level
 * turns the cheapest intent into the most expensive request, so a stored
 * effort is degraded to the nearest level below - never raised.
 */

/** The effort levels a model can offer, cheapest first; "default" is the cheapest. */
const EFFORT_LADDER = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function variant(id: string) {
  return { id, label: id.charAt(0).toUpperCase() + id.slice(1), providerOptions: {} };
}

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

  it('keeps a listed effort exactly as stored', async () => {
    const { resolveReasoningVariant } = await import('../src/provider/registry.js');
    const variants = ['default', 'low', 'medium', 'high', 'xhigh', 'max'].map(variant);
    expect(resolveReasoningVariant(variants, 'medium').id).toBe('medium');
  });
});