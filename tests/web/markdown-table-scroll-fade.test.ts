import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Textual pins live in the root program: the web tsconfig declares no node types
// (same pattern as tests/web/transcript-scroll-fade.test.ts).
function source(relative: string): string {
  return readFileSync(relative, 'utf8');
}

describe('markdown table soft edge shadow (the shared scroll-fade family, horizontal)', () => {
  it('marks the horizontal table region with the x fade and binds the shared updater', () => {
    const markdown = source('web/src/markdown.tsx');
    expect(markdown).toContain("import { bindScrollFade } from './components/scroll-area.js';");
    expect(markdown).toContain("const MarkdownTableRegion = ({ node: _node, ...props }: ComponentProps<'table'> & ExtraProps)");
    expect(markdown).toContain('useLayoutEffect(() => bindScrollFade(ref.current), []);');
    // The region keeps its accessibility contract while gaining the fade class.
    expect(markdown).toContain(
      '<div ref={ref} className="markdown-table-scroll scroll-fade-x" role="region" aria-label="Table" tabIndex={0} data-scroll-viewport>',
    );
    // Stable component identity in the components map (streaming re-renders).
    expect(markdown).toContain('table: MarkdownTableRegion,');
  });

  it('extends the one fade helper with horizontal edges and a shared binder', () => {
    const scrollArea = source('web/src/components/scroll-area.tsx');
    expect(scrollArea).toContain('element.dataset.fadeLeft = String(element.scrollLeft > 1);');
    expect(scrollArea).toContain('element.dataset.fadeRight = String(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);');
    expect(scrollArea).toContain('export function bindScrollFade(element: HTMLElement | null): (() => void) | undefined');
    // ScrollArea and the binder both call the same updater; the math exists once.
    expect(scrollArea).toContain('const fade = () => updateScrollFade(node);');
    expect(scrollArea).toContain('const update = () => updateScrollFade(element);');
    const definitions = scrollArea.match(/export function updateScrollFade\(/g) ?? [];
    expect(definitions.length).toBe(1);
  });

  it('draws the horizontal mask from the same variable family', () => {
    const styles = source('web/src/styles.css');
    expect(styles).toContain('@property --scroll-fade-left');
    expect(styles).toContain('@property --scroll-fade-right');
    const xRule = styles.match(/\.scroll-fade-x\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(xRule).toContain('to right');
    expect(xRule).toContain('#000 var(--scroll-fade-left)');
    expect(xRule).toContain('#000 calc(100% - var(--scroll-fade-right))');
    expect(styles).toContain(".scroll-fade-x[data-fade-left='true']");
    expect(styles).toContain(".scroll-fade-x[data-fade-right='true']");
    // The vertical surface stays vertical: transcript and steps look unchanged.
    const baseRule = styles.match(/\.scroll-fade\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(baseRule).toContain('to bottom');
  });
});
