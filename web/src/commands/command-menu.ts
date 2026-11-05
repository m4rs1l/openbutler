/**
 * Keyboard logic for the composer's slash menu.
 *
 * Kept out of the component so the traversal that arrow keys perform is a pure
 * value in its own right: the panel renders a list and this decides which row
 * owns the selection, with no DOM anywhere near it.
 */

/**
 * The row an arrow key moves the selection to, or null when the key is not one
 * the menu owns — the caller then leaves the key to whatever else handles it
 * (message history, a newline, the global Escape).
 *
 * Both ends wrap, so ArrowUp on the first row lands on the last one and
 * ArrowDown on the last returns to the first. An out-of-range starting index is
 * normalized first: the list can shrink under the selection while the owner
 * keeps typing.
 */
export function moveCommandIndex(key: string, activeIndex: number, count: number): number | null {
  if (count <= 0) return null;
  const current = Math.min(Math.max(activeIndex, 0), count - 1);
  if (key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowUp') return (current - 1 + count) % count;
  return null;
}
