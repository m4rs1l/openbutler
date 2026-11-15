import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Textual pins live in the root program: the web tsconfig declares no node types
// (same pattern as tests/web/message-actions-stylesheet.test.ts).
function source(relative: string): string {
  return readFileSync(relative, 'utf8');
}

describe('transcript scroll-fade (the shared soft edge shadow at the composer seam)', () => {
  it('marks the transcript scroller with the scroll-fade surface', () => {
    const virtual = source('web/src/virtual.tsx');
    expect(virtual).toContain('className="scroller scroll-fade"');
    expect(virtual).toContain("import { updateScrollFade } from './components/scroll-area.js';");
  });

  it('refreshes the fade on scroll, viewport growth and layout commits', () => {
    const virtual = source('web/src/virtual.tsx');
    // One import plus four calls: mount, ResizeObserver, scroll handler, layout effect.
    const calls = virtual.match(/updateScrollFade\(element\)/g) ?? [];
    expect(calls.length).toBe(4);
    expect(virtual).toMatch(/follower\.current\?\.track\(\);\s*updateScrollFade\(element\);/);
    expect(virtual).toMatch(/layout\.current = \{ keys, offsets, footer \};\s*updateScrollFade\(element\);/);
  });

  it('keeps the fade logic in one shared helper used by ScrollArea too', () => {
    const scrollArea = source('web/src/components/scroll-area.tsx');
    expect(scrollArea).toContain('export function updateScrollFade(element: HTMLElement | null): void');
    expect(scrollArea).toContain('const fade = () => updateScrollFade(node);');
    // The component ships the fade class itself so every call site inherits it.
    expect(scrollArea).toContain('scroll-area scroll-fade');
    // One vocabulary: the old name is gone everywhere.
    expect(scrollArea).not.toContain('updateEdgeFade');
    const virtual = source('web/src/virtual.tsx');
    expect(virtual).not.toContain('updateEdgeFade');
    expect(virtual).not.toContain('scroller scroll-area');
  });

  it('separates the scroll surface from the fade CSS', () => {
    const styles = source('web/src/styles.css');
    const fadeRule = styles.match(/\.scroll-fade\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(fadeRule).toContain('mask-image: linear-gradient');
    expect(fadeRule).toContain('transition:');
    expect(styles).toContain(".scroll-fade[data-fade-top='true']");
    expect(styles).toContain(".scroll-fade[data-fade-bottom='true']");
    expect(styles).toMatch(/--scroll-fade-bottom: 12px/);
    const surfaceRule = styles.match(/\.scroll-area\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(surfaceRule).toContain('overflow-anchor: none');
    expect(surfaceRule).not.toContain('mask-image');
  });
});
