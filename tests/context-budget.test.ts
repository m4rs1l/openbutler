import { describe, expect, it } from 'vitest';
import { resolveContextBudget } from '../src/context-budget.js';

describe('resolveContextBudget', () => {
  it('decides window and output from the same authority in one call', () => {
    // The shipped 2026-11-03 bug read context as settings > catalog and output
    // as catalog > settings in the same function; one call cannot do that.
    const overridden = resolveContextBudget({ context: 262_144, output: 8_192 }, { context: 1_048_576, output: 32_768 });
    expect(overridden).toEqual({ window: 262_144, output: 8_192, windowSource: 'settings' });

    const catalogOnly = resolveContextBudget(undefined, { context: 1_048_576, output: 32_768 });
    expect(catalogOnly).toEqual({ window: 1_048_576, output: 32_768, windowSource: 'catalog' });
  });

  it('falls back per field when the override states only one number', () => {
    const windowOnly = resolveContextBudget({ context: 500_000 }, { context: 1_048_576, output: 32_768 });
    expect(windowOnly).toEqual({ window: 500_000, output: 32_768, windowSource: 'settings' });

    const outputOnly = resolveContextBudget({ output: 4_096 }, { context: 1_048_576 });
    expect(outputOnly).toEqual({ window: 1_048_576, output: 4_096, windowSource: 'catalog' });
  });

  it('reports an unknown window when neither authority states one', () => {
    expect(resolveContextBudget(undefined, undefined)).toEqual({ window: null, output: null, windowSource: 'unknown' });
    expect(resolveContextBudget(null, {})).toEqual({ window: null, output: null, windowSource: 'unknown' });
  });

  it('treats a null override field as absent rather than as a value', () => {
    expect(resolveContextBudget({ context: null }, { context: 100_000 })).toEqual({
      window: 100_000,
      output: null,
      windowSource: 'catalog',
    });
  });
});
