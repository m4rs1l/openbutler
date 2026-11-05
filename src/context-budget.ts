/**
 * The single authority for a model's context budget.
 *
 * Every consumer (runtime creation, model switching, compaction, meters) reads
 * one resolved value instead of re-deriving the priority rule. Settings and
 * catalog are consulted together in one call so `window` and `output` cannot
 * resolve from different authorities at the same call site — the divergence
 * that shipped `settings > catalog` for context and `catalog > settings` for
 * output in one function over a live incident (2026-11-03).
 */

/** Where a model's budget numbers come from: the explicit settings override, else the catalog. */
export interface ContextBudgetAuthority {
  /** Owner-set token window/output in `providers.<p>.modelSpecs.<m>`. */
  context?: number | null;
  output?: number | null;
}

export interface ContextBudget {
  /** Model-visible token window; null when neither authority states one. */
  window: number | null;
  /** Output allowance for one model request; null when unspecified. */
  output: number | null;
  /** Which authority decided the window, for a meter to label the number with. */
  windowSource: 'settings' | 'catalog' | 'unknown';
}

/**
 * Resolve the budget for one provider/model pair.
 *
 * The owner's explicit `modelSpecs` entry always beats the catalog for both
 * fields together; a field the override omits falls back to the catalog. The
 * caller validates the window with `requireModelContextWindow`, because an
 * unknown window is a hard configuration error, not a default.
 */
export function resolveContextBudget(
  override: ContextBudgetAuthority | null | undefined,
  catalog: ContextBudgetAuthority | null | undefined,
): ContextBudget {
  const window = override?.context ?? catalog?.context ?? null;
  return {
    window,
    output: override?.output ?? catalog?.output ?? null,
    windowSource: window === null ? 'unknown' : override?.context != null ? 'settings' : 'catalog',
  };
}
