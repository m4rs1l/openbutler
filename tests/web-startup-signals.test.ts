import { describe, expect, it } from 'vitest';

/**
 * Two signals the web/startup paths must give, pinned at their pure sources:
 * an explicit --hostname/--port that the running server does not honor is a
 * conflict the caller must surface (the running bind keeps serving), and an
 * early child death must classify a deterministic guard as non-retryable and
 * never leave the owner with a bare "exited before becoming ready" and no
 * next step.
 */
describe('web bind conflict detection', () => {
  it('stays quiet without explicit bind flags and reports a real mismatch', async () => {
    const { webBindMismatch } = await import('../src/cli/web.js');
    const running = { host: '100.115.65.6', port: 45278 };
    // No flags: a plain start keeps whatever is running, nothing was asked.
    expect(webBindMismatch(running, { host: '127.0.0.1', port: 45278 }, { hostname: false, port: false })).toBe(false);
    // The same values the server already has: idempotent, nothing to say.
    expect(webBindMismatch(running, running, { hostname: true, port: true })).toBe(false);
    // Explicit host the running server is NOT bound to: the user must hear it.
    expect(webBindMismatch(running, { host: '100.115.65.6', port: 45300 }, { hostname: false, port: true })).toBe(true);
    expect(webBindMismatch(running, { host: '127.0.0.1', port: 45278 }, { hostname: true, port: false })).toBe(true);
  });
});

describe('startup failure diagnosis', () => {
  it('classifies the web bundle guard as deterministic: no pointless retry', async () => {
    const { diagnoseStartupFailure } = await import('../src/daemon.js');
    const guard = 'The browser client bundle (dist/client) is missing. Re-run the installer with --web, or build it with npm run build:web.';
    const error = diagnoseStartupFailure('web server', { code: 1, signal: null }, guard);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('Re-run the installer with --web');
  });

  it('never leaves an empty-tail failure without a next step', async () => {
    const { diagnoseStartupFailure } = await import('../src/daemon.js');
    const error = diagnoseStartupFailure('web server', { code: 1, signal: null }, '');
    expect(error.message).toContain('exited before becoming ready');
    expect(error.message).toMatch(/openbutler logs/);
  });

  it('keeps the out-of-memory diagnosis retryable with its advice', async () => {
    const { diagnoseStartupFailure } = await import('../src/daemon.js');
    const error = diagnoseStartupFailure('host', { code: 134, signal: null }, 'Zone Allocation failed');
    expect(error.message).toContain('ran out of memory');
    expect(error.retryable).toBe(true);
  });
});
