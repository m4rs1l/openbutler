import { describe, expect, it } from 'vitest';
import { buildLayoutWindow } from './layout.js';

const keysOf = (count: number) => Array.from({ length: count }, (_, index) => `t${index}`);
const base = { estimate: 180, overscan: 6, viewport: 800, windowTop: 0 };

describe('transcript layout stays local', () => {
  it("moves the total by only the measured row's own delta, never the unmeasured count", () => {
    // 300 turns, three measured (average 150). Measuring one far-away turn in a
    // batch must move the model by that row's delta alone: the resize bug was a
    // measurement restretching all ~296 unmeasured rows through the average.
    const keys = keysOf(300);
    const heights = new Map([
      ['t297', 120],
      ['t298', 150],
      ['t299', 180],
    ]);
    const fallback = new Map<string, number>();
    const before = buildLayoutWindow({ ...base, keys, heights, fallback });
    const batch = new Map(heights);
    batch.set('t150', 400);
    const after = buildLayoutWindow({ ...base, keys, heights: batch, fallback });
    // 400 replaced its 150 fallback snapshot: the model may move by exactly 250.
    expect(after.total - before.total).toBeCloseTo(250, 5);
    for (let index = 0; index <= 150; index += 1) expect(after.offsets[index]).toBe(before.offsets[index]);
    for (let index = 151; index <= 300; index += 1) expect(after.offsets[index] - before.offsets[index]).toBeCloseTo(250, 5);
  });

  it('keeps each fallback snapshot when a later measurement arrives', () => {
    const keys = keysOf(40);
    const fallback = new Map<string, number>();
    const first = buildLayoutWindow({ ...base, keys, heights: new Map([['t39', 300]]), fallback });
    const second = buildLayoutWindow({
      ...base,
      keys,
      heights: new Map([
        ['t39', 300],
        ['t10', 500],
      ]),
      fallback,
    });
    // t10 replaced its 300 fallback snapshot: rows after it shift by exactly 200.
    expect(second.offsets[11] - first.offsets[11]).toBeCloseTo(200, 5);
    for (let index = 0; index <= 10; index += 1) expect(second.offsets[index]).toBe(first.offsets[index]);
    expect(second.total - first.total).toBeCloseTo(200, 5);
  });

  it('re-measuring a settled row moves only that row', () => {
    const keys = keysOf(20);
    const fallback = new Map<string, number>();
    const before = buildLayoutWindow({ ...base, keys, heights: new Map([['t5', 200]]), fallback });
    const after = buildLayoutWindow({ ...base, keys, heights: new Map([['t5', 170]]), fallback });
    expect(after.total - before.total).toBeCloseTo(-30, 5);
    for (let index = 0; index <= 5; index += 1) expect(after.offsets[index]).toBe(before.offsets[index]);
    expect(after.offsets[20] - before.offsets[20]).toBeCloseTo(-30, 5);
  });

  it('models unmeasured rows on the estimate before anything is measured', () => {
    const keys = keysOf(10);
    const fallback = new Map<string, number>();
    const layout = buildLayoutWindow({ ...base, keys, heights: new Map(), fallback });
    expect(layout.total).toBe(10 * base.estimate);
    expect(fallback.get('t0')).toBe(base.estimate);
    expect(fallback.get('t9')).toBe(base.estimate);
  });
});

describe('mounted window selection', () => {
  it('mounts the tail when no scroll position exists yet', () => {
    const keys = keysOf(50);
    const fallback = new Map<string, number>();
    const layout = buildLayoutWindow({
      ...base,
      keys,
      heights: new Map([
        ['t48', 100],
        ['t49', 10_000],
      ]),
      fallback,
      windowTop: null,
    });
    expect(layout.end).toBe(50);
    // Unmeasured rows model on the measured average: (100 + 10_000) / 2.
    expect(layout.total).toBe(48 * 5050 + 100 + 10_000);
  });

  it('brackets the window around the scroll position with overscan', () => {
    const keys = keysOf(50);
    const heights = new Map(keys.map((key) => [key, 100]));
    const fallback = new Map<string, number>();
    const layout = buildLayoutWindow({ ...base, keys, heights, fallback, viewport: 500, overscan: 6, windowTop: 2000 });
    // offsets[i] = 100i: the viewport top sits at row 15 and the window ends
    // where offsets reach windowTop + 2 viewports (row 30), plus overscan.
    expect(layout.start).toBe(8);
    expect(layout.end).toBe(36);
    expect(layout.offsets[layout.end]).toBeGreaterThanOrEqual(2000 + 500 * 2);
  });
});
