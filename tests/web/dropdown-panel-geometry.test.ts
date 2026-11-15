import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Textual pins live in the root program: the web tsconfig declares no node types
// (same pattern as tests/web/transcript-scroll-fade.test.ts).
function source(relative: string): string {
  return readFileSync(relative, 'utf8');
}

// The panel box must have exactly one owner: the anchor math that writes
// style.top/left and the panel's own size. A layout projection on the box
// re-animates those corrections (0.2s eased scale+translate) and reads as the
// content sliding in from the bottom-left while the surface already jumped.
describe('dropdown panel geometry (the anchor owns the box, not layout projection)', () => {
  it('does not enable layout projection on the root panel box', () => {
    const dropdown = source('web/src/components/selection/dropdown.tsx');
    const start = dropdown.indexOf('ref={panelRef}');
    const end = dropdown.indexOf('role={panelRole', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const panel = dropdown.slice(start, end);
    // No layout, no layoutDependency, no layout transition on the panel itself:
    // size and position changes must land in the same commit that computed them.
    expect(panel).not.toMatch(/\blayout\b/);
    expect(panel).not.toContain('layoutDependency');
  });

  it('keeps the surface as the projection root so children ignore anchor jumps', () => {
    const dropdown = source('web/src/components/selection/dropdown.tsx');
    const start = dropdown.indexOf('ref={surfaceRef}');
    const end = dropdown.indexOf('layoutRoot', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const surface = dropdown.slice(start, end);
    expect(surface).toContain('// layout projection. Children animate relative to this stable root.');
    expect(dropdown.slice(end, end + 'layoutRoot'.length)).toBe('layoutRoot');
  });

  it('keeps content motion in position-only row animations and the opacity entry fade', () => {
    const dropdown = source('web/src/components/selection/dropdown.tsx');
    // header button, header div, panel content, footer: rows may ease, the box may not.
    const position = dropdown.match(/layout=\{reducedMotion \? false : 'position'\}/g) ?? [];
    expect(position.length).toBe(4);
    expect(dropdown).toContain('void contentAnimation.start({ opacity: 1, transition: surfaceLayoutTransition });');
  });
});
