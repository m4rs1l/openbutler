import { describe, expect, it } from 'vitest';
import { moveCommandIndex } from './command-menu.js';

describe('moveCommandIndex', () => {
  it('walks down through the rows and wraps past the last one', () => {
    expect(moveCommandIndex('ArrowDown', 0, 4)).toBe(1);
    expect(moveCommandIndex('ArrowDown', 2, 4)).toBe(3);
    expect(moveCommandIndex('ArrowDown', 3, 4)).toBe(0);
  });

  it('walks up and wraps from the first row to the last', () => {
    expect(moveCommandIndex('ArrowUp', 3, 4)).toBe(2);
    expect(moveCommandIndex('ArrowUp', 1, 4)).toBe(0);
    expect(moveCommandIndex('ArrowUp', 0, 4)).toBe(3);
  });

  it('stays on the only row when the menu has a single command', () => {
    expect(moveCommandIndex('ArrowDown', 0, 1)).toBe(0);
    expect(moveCommandIndex('ArrowUp', 0, 1)).toBe(0);
  });

  it('ignores every key the menu does not own, so the composer keeps it', () => {
    expect(moveCommandIndex('Enter', 0, 4)).toBeNull();
    expect(moveCommandIndex('Escape', 1, 4)).toBeNull();
    expect(moveCommandIndex('a', 0, 4)).toBeNull();
    expect(moveCommandIndex('ArrowLeft', 0, 4)).toBeNull();
  });

  it('refuses to select anything from an empty menu', () => {
    expect(moveCommandIndex('ArrowDown', 0, 0)).toBeNull();
    expect(moveCommandIndex('ArrowUp', 2, 0)).toBeNull();
  });

  it('normalizes a selection the shrunken list no longer contains', () => {
    expect(moveCommandIndex('ArrowDown', 3, 1)).toBe(0);
    expect(moveCommandIndex('ArrowUp', -1, 4)).toBe(3);
  });
});
