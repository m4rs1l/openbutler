import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VirtualList } from './virtual.js';

interface Row {
  id: string;
}
const rows: Row[] = [{ id: 'turn-1' }, { id: 'turn-2' }];

function renderList(): string {
  const element: ReactElement = createElement(VirtualList<Row>, {
    items: rows,
    getKey: (row: Row) => row.id,
    hasOlder: false,
    render: (row: Row) => createElement('div', null, row.id),
  });
  return renderToStaticMarkup(element);
}

describe('virtual list initial paint', () => {
  it('renders the tail rows on the first frame, scroller not hidden', () => {
    const html = renderList();
    expect(html).toContain('turn-2');
    expect(html).not.toContain('visibility:hidden');
  });
});
