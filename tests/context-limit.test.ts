import { describe, expect, it } from 'vitest';
import { compactionContextWindowTokens, effectiveContextWindowTokens } from '../src/session-store.js';
import { CUSTODIAN_SESSION_ID } from '../src/session-paths.js';

describe('compactionContextWindowTokens', () => {
  it('caps the custodian by its identity and leaves every chat on the model window', () => {
    expect(compactionContextWindowTokens(CUSTODIAN_SESSION_ID, 1_048_576, 100_000)).toBe(200_000);
    expect(compactionContextWindowTokens('1af4a818-4f76-434f-8a74-0215b89546f5', 1_048_576, 100_000)).toBe(1_048_576);
  });

  it('returns the full window once the custodian has passed its cap', () => {
    expect(compactionContextWindowTokens(CUSTODIAN_SESSION_ID, 1_048_576, 240_000)).toBe(1_048_576);
  });

  it('takes the configured limit for the head and never for a chat', () => {
    // The owner's setting is read here, at the decision, and never stored on a record.
    expect(compactionContextWindowTokens(CUSTODIAN_SESSION_ID, 1_048_576, 50_000, 96_000)).toBe(96_000);
    expect(compactionContextWindowTokens('1af4a818-4f76-434f-8a74-0215b89546f5', 1_048_576, 50_000, 96_000)).toBe(1_048_576);
    // A configured limit above the model window is clamped by the window itself.
    expect(compactionContextWindowTokens(CUSTODIAN_SESSION_ID, 400_000, 100_000, 2_000_000)).toBe(400_000);
  });
});

describe('effectiveContextWindowTokens', () => {
  it('keeps the model window for sessions without a cap', () => {
    expect(effectiveContextWindowTokens(1_048_576, undefined, undefined)).toBe(1_048_576);
    expect(effectiveContextWindowTokens(1_048_576, undefined, 900_000)).toBe(1_048_576);
  });

  it('applies the stamped cap while measured context is under it', () => {
    expect(effectiveContextWindowTokens(1_048_576, 200_000, undefined)).toBe(200_000);
    expect(effectiveContextWindowTokens(1_048_576, 200_000, 150_000)).toBe(200_000);
  });

  it('returns the full window once measured context has passed the cap', () => {
    // Compaction cannot summarise down through a limit its own request would
    // already exceed, so an oversized chat keeps normal behaviour instead of
    // failing at every step boundary.
    expect(effectiveContextWindowTokens(1_048_576, 200_000, 240_000)).toBe(1_048_576);
    expect(effectiveContextWindowTokens(1_048_576, 200_000, 200_000)).toBe(1_048_576);
  });

  it('never invents a window when the model has none', () => {
    expect(effectiveContextWindowTokens(null, 200_000, undefined)).toBeNull();
    expect(effectiveContextWindowTokens(null, undefined, 100_000)).toBeNull();
  });

  it('never lets the cap exceed the model window', () => {
    expect(effectiveContextWindowTokens(128_000, 200_000, undefined)).toBe(128_000);
    expect(effectiveContextWindowTokens(128_000, 200_000, 90_000)).toBe(128_000);
  });
});
