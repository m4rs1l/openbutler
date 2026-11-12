import { describe, expect, it } from 'vitest';
import { diagnoseStartupFailure, withStartupRetry } from '../src/daemon.js';

describe('startup failure diagnosis', () => {
  it('treats a native out-of-memory abort as transient and points at the pagefile', () => {
    for (const exit of [
      { code: 134, signal: null },
      { code: null, signal: 'SIGABRT' as const },
    ]) {
      const error = diagnoseStartupFailure('web server', exit, '');
      expect(error.retryable).toBe(true);
      expect(error.message).toContain('ran out of memory');
      expect(error.message).toContain('pagefile');
    }
    // The exact signature the owner saw: V8 loses a native zone allocation under
    // commit pressure and aborts, which a retry seconds later can survive.
    const zone = diagnoseStartupFailure(
      'web server',
      { code: 1, signal: null },
      'FATAL ERROR: Zone Allocation failed - process out of memory',
    );
    expect(zone.retryable).toBe(true);
    expect(zone.message).toContain('Zone Allocation failed');
  });

  it('does not retry a deterministic fault and keeps its cause', () => {
    for (const tail of [
      'EADDRINUSE: address already in use 127.0.0.1:46000',
      'SyntaxError: Unexpected token',
      'Error: Cannot find module ./missing.js',
    ]) {
      const error = diagnoseStartupFailure('web server', { code: 1, signal: null }, tail);
      expect(error.retryable).toBe(false);
      expect(error.message).toContain(tail);
    }
  });

  it('does not retry a child that died because a host is already running', () => {
    // A second `daemon start` racing a live host exits with this message; waiting
    // cannot make the running host go away, so it must surface at once, not after
    // the whole backoff budget.
    const error = diagnoseStartupFailure('host', { code: 1, signal: null }, 'Error: An OpenButler host is already running (pid 4242).');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('already running');
  });

  it('retries an unrecognised early death, since waiting may still fix it', () => {
    const error = diagnoseStartupFailure('host', { code: 1, signal: null }, 'something unexpected');
    expect(error.retryable).toBe(true);
  });
});

describe('bounded startup retry', () => {
  it('retries a transient death and returns the eventual success', async () => {
    const transient = diagnoseStartupFailure('web server', { code: 134, signal: null }, '');
    let attempts = 0;
    const result = await withStartupRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw transient;
      return 'ready';
    });
    expect(result).toBe('ready');
    expect(attempts).toBe(2);
  });

  it('fails fast on a deterministic fault without waiting', async () => {
    const fatal = diagnoseStartupFailure('web server', { code: 1, signal: null }, 'EADDRINUSE: address already in use');
    let attempts = 0;
    await expect(
      withStartupRetry(async () => {
        attempts += 1;
        throw fatal;
      }),
    ).rejects.toBe(fatal);
    expect(attempts).toBe(1);
  });

  it('gives up once the backoff budget is spent', async () => {
    const transient = diagnoseStartupFailure('host', { code: 134, signal: null }, '');
    let attempts = 0;
    await expect(
      withStartupRetry(async () => {
        attempts += 1;
        throw transient;
      }),
    ).rejects.toBe(transient);
    // The first try plus one per backoff slot, then the error surfaces.
    expect(attempts).toBe(3);
  }, 10_000);
});
