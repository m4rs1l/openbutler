/**
 * Pure transcript geometry: row heights become offsets, a total height, and
 * the mounted window. Kept free of the DOM and React so the rule that makes
 * scrolling stable — one row's measurement moves only that row — is testable
 * without a browser.
 *
 * The instability this module exists to prevent: when every never-measured row
 * takes the *current* average of measured rows, measuring one row changes the
 * modeled height of every unmeasured row. Offsets are cumulative, so a single
 * measurement then relocates up to `unmeasured × Δaverage` pixels of content —
 * a resize re-measures many rows, and the transcript visibly jumps.
 */
export interface LayoutWindow {
  offsets: number[];
  total: number;
  /** First mounted row index. */
  start: number;
  /** One past the last mounted row index. */
  end: number;
}

export interface LayoutInput {
  keys: readonly string[];
  heights: ReadonlyMap<string, number>;
  /**
   * The height a never-measured row is modeled with. Chosen once per key and
   * kept: later measurements of other rows must not restretch it.
   */
  fallback: Map<string, number>;
  estimate: number;
  overscan: number;
  /**
   * Content coordinate of the viewport top. `null` places the tail instead —
   * the initial mount walks down from the estimates, so it must not stride
   * the whole history before measurements arrive.
   */
  windowTop: number | null;
  viewport: number;
}

export function buildLayoutWindow({ keys, heights, fallback, estimate, overscan, windowTop, viewport }: LayoutInput): LayoutWindow {
  const loaded = heights.size;
  let measuredSum = 0;
  for (const value of heights.values()) measuredSum += value;
  const average = loaded === 0 ? estimate : measuredSum / loaded;
  const offsets: number[] = new Array(keys.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const measured = heights.get(key);
    let height = measured;
    if (height === undefined) {
      height = fallback.get(key);
      if (height === undefined) fallback.set(key, (height = average));
    }
    offsets[index + 1] = offsets[index]! + height;
  }
  const total = offsets[keys.length]!;
  const top = windowTop === null ? Math.max(0, total - viewport) : windowTop;
  let start = 0;
  while (start < keys.length && offsets[start + 1]! < top - viewport) start += 1;
  start = Math.max(0, start - overscan);
  let end = start;
  while (end < keys.length && offsets[end]! < top + viewport * 2) end += 1;
  end = Math.min(keys.length, end + overscan);
  return { offsets, total, start, end };
}
