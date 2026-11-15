/**
 * Serve guard for the split payloads (Phase 5, v2).
 *
 * The `web` archive is an overlay: a base install without it has no
 * dist/client. The server must refuse to start with one actionable message
 * instead of serving an empty shell page, and the same resolver must still
 * find a bundle that ships next to the server (packaged) or above the source
 * tree (dev), so both remedies in the message stay true.
 *
 * The fixture directories nest deep under the OS temp dir so the 6-level
 * walk-up can never stumble into this repository's own dist/client.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { requireDefaultAssetsDir } from '../src/web/server.js';

const fixtures = mkdtempSync(join(tmpdir(), 'openbutler-assets-guard-'));
// 6 walk-up levels start at the fixture itself; this depth keeps the walk
// inside the temp fixture for the negative case.
const withoutBundle = join(fixtures, join('a', 'b', 'c', 'd', 'e', 'f', 'g', 'hole'));
const withBundle = join(fixtures, 'bundle');
mkdirSync(withoutBundle, { recursive: true });
mkdirSync(join(withBundle, 'dist', 'client'), { recursive: true });
writeFileSync(join(withBundle, 'dist', 'client', 'index.html'), '<!doctype html>');

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

describe('web bundle guard', () => {
  it('returns the bundle directory when the overlay (or a build) is present', () => {
    expect(requireDefaultAssetsDir(withBundle)).toBe(join(withBundle, 'dist', 'client'));
  });

  it('refuses to serve when no bundle is installed, naming both remedies', () => {
    expect(() => requireDefaultAssetsDir(withoutBundle)).toThrow('Re-run the installer with --web, or build it with npm run build:web.');
  });
});
