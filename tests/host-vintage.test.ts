import { describe, expect, it } from 'vitest';
import { hostVintage, hostVintageMismatchWarning } from '../src/daemon.js';

describe('host vintage', () => {
  it('classifies a host entry as source, dist, or unknown', () => {
    expect(hostVintage('C:\\repo\\src\\cli.ts')).toBe('source');
    expect(hostVintage('/home/me/app/src/cli.tsx')).toBe('source');
    expect(hostVintage('C:\\app\\dist\\cli.js')).toBe('dist');
    expect(hostVintage('/opt/openbutler/dist/cli.js')).toBe('dist');
    expect(hostVintage(undefined)).toBe('unknown');
    expect(hostVintage('')).toBe('unknown');
  });

  it('detects different compiled builds even when both processes use the same dist entry', () => {
    const warning = hostVintageMismatchWarning('/app/dist/cli.js', '/app/dist/cli.js', 'compiled-new', 'compiled-old');
    expect(warning).toContain('Backend build mismatch');
    expect(warning).toContain('compiled-new');
    expect(warning).toContain('compiled-old');
    expect(warning).toContain('openbutler restart');
  });

  it('accepts equal known compiled builds regardless of installation path', () => {
    expect(hostVintageMismatchWarning('/new/dist/cli.js', 'C:\\old\\dist\\cli.js', 'same-build', 'same-build')).toBeNull();
  });

  it.each([undefined, null, ''])('does not invent compiled identities when one is %s', (unknownId) => {
    expect(hostVintageMismatchWarning('/app/dist/cli.js', '/app/dist/cli.js', 'known-build', unknownId)).toBeNull();
    expect(hostVintageMismatchWarning('/app/dist/cli.js', '/app/dist/cli.js', unknownId, 'known-build')).toBeNull();
  });

  it('preserves source/dist warnings without IDs and ignores IDs on source or unknown entries', () => {
    expect(hostVintageMismatchWarning('/app/dist/cli.js', '/repo/src/cli.ts', 'known-build', null)).toContain('Code vintage mismatch');
    expect(hostVintageMismatchWarning('/repo/src/cli.ts', '/app/dist/cli.js', null, undefined)).toContain('Code vintage mismatch');
    expect(hostVintageMismatchWarning('/repo/src/cli.ts', '/repo/src/cli.ts', 'new', 'old')).toBeNull();
    expect(hostVintageMismatchWarning(undefined, '/app/dist/cli.js', 'new', 'old')).toBeNull();
    expect(hostVintageMismatchWarning('/app/dist/cli.js', undefined, 'new', 'old')).toBeNull();
  });

  it('names a vintage skew once and stays quiet when both sides match', () => {
    const warning = hostVintageMismatchWarning('/repo/src/cli.ts', '/app/dist/cli.js');
    expect(warning).toContain('Code vintage mismatch');
    expect(warning).toContain('source (tsx)');
    expect(warning).toContain('built bundle');
    expect(warning).toContain('openbutler restart');
    expect(hostVintageMismatchWarning('/app/dist/cli.js', '/app/dist/cli.js')).toBeNull();
    expect(hostVintageMismatchWarning('/repo/src/cli.ts', undefined)).toBeNull();
    expect(hostVintageMismatchWarning('/repo/src/cli.ts', null)).toBeNull();
  });
});
