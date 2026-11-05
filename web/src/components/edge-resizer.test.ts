import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EdgeResizer } from './edge-resizer.js';

describe('EdgeResizer component', () => {
  const dummyEdge = {
    dragging: false,
    start() {},
    move() {},
    finish() {},
  };

  it('renders standard separator with ARIA semantics', () => {
    const html = renderToStaticMarkup(
      createElement(EdgeResizer, {
        edge: dummyEdge,
        className: 'sidebar-resizer',
        label: 'Resize sidebar',
        controls: 'sidebar-nav',
        min: 180,
        max: 560,
        value: 252,
        title: 'Drag to resize sidebar',
      }),
    );
    expect(html).toContain('role="separator"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('class="sidebar-resizer"');
    expect(html).toContain('aria-label="Resize sidebar"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-controls="sidebar-nav"');
    expect(html).toContain('aria-valuemin="180"');
    expect(html).toContain('aria-valuemax="560"');
    expect(html).toContain('aria-valuenow="252"');
    expect(html).toContain('aria-valuetext="252 pixels"');
    expect(html).toContain('title="Drag to resize sidebar"');
  });

  it('respects hidden prop and renders children', () => {
    const html = renderToStaticMarkup(
      createElement(
        EdgeResizer,
        {
          edge: dummyEdge,
          hidden: true,
          className: 'panel-resizer',
          label: 'Resize right panel',
          controls: 'panel-right',
          min: 0,
          max: 800,
          value: 0,
        },
        createElement('span', { className: 'handle' }),
      ),
    );
    expect(html).toContain('hidden=""');
    expect(html).toContain('<span class="handle"></span>');
  });
});
