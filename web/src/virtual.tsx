import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { bindReaderGestures, createScrollFollower, type ScrollFollower } from './scroll-follow.js';
import { updateScrollFade } from './components/scroll-area.js';
import { shouldLoadOlderFitted } from './load-older.js';
import { buildLayoutWindow } from './layout.js';

interface VirtualListProps<T> {
  items: T[];
  getKey: (item: T) => string;
  estimate?: number;
  overscan?: number;
  render: (item: T, absoluteIndex: number) => ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  onLoadOlder?: () => void;
  hasOlder: boolean;
  loadingOlder?: boolean;
  /** Changes only when the caller explicitly requests the newest content. */
  followRequest?: number;
}

function MeasuredRow({
  index,
  top,
  measure,
  children,
}: {
  index: string;
  top: number;
  measure: (index: string, node: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = row.current;
    if (!node) return;
    // A measurement only queues a layout pass; the pass commits once per frame.
    // Committing inside every observer callback turned a resize into a render
    // storm where each height change moved the offsets the next one measured.
    const observer = new ResizeObserver(() => measure(index, node));
    observer.observe(node);
    measure(index, node);
    return () => observer.disconnect();
  }, [index, measure]);
  return (
    <div ref={row} className="row" style={{ transform: `translateY(${top}px)` }}>
      {children}
    </div>
  );
}

/**
 * Rows live in a tall spacer and only the visible slice is mounted, so a long
 * transcript costs a few dozen DOM nodes instead of thousands. Heights are
 * measured before paint and cached, which keeps scroll geometry exact without
 * laying out off-screen rows.
 */
export function VirtualList<T>({
  items,
  getKey,
  estimate = 96,
  overscan = 6,
  render,
  header,
  footer,
  onLoadOlder,
  hasOlder,
  loadingOlder = false,
  followRequest,
}: VirtualListProps<T>) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const heights = useRef(new Map<string, number>());
  // A never-measured row keeps the average it first saw: one row's measurement
  // must never restretch every other unmeasured row's modeled position.
  const fallback = useRef(new Map<string, number>());
  const measurementRevision = useRef(0);
  const initializing = useRef(true);
  const [revision, setTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(800);
  const follower = useRef<ScrollFollower | null>(null);
  const layout = useRef<{ keys: string[]; offsets: number[]; footer: ReactNode } | null>(null);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const followedRequest = useRef(followRequest);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const created = createScrollFollower(element);
    follower.current = created;
    updateScrollFade(element);
    const unbind = bindReaderGestures(element, created);
    return () => {
      unbind();
      created.destroy();
      follower.current = null;
    };
  }, []);

  const captureAnchor = useCallback(() => {
    const element = scroller.current;
    const previous = layout.current;
    if (!element || !previous) return;
    const rows = element.querySelector<HTMLElement>('.rows');
    const localTop = element.scrollTop - (rows ? rows.offsetTop - element.offsetTop : 0);
    const index = previous.keys.findIndex((_, i) => previous.offsets[i + 1] > localTop);
    anchor.current = index < 0 ? null : { key: previous.keys[index], offset: localTop - previous.offsets[index] };
  }, []);

  const pendingHeights = useRef(new Map<string, number>());
  const flushHandle = useRef<number | null>(null);
  /**
   * One layout pass per frame. Every measurement lands in `pendingHeights`;
   * this pass captures the reader's anchor once, applies the whole batch in a
   * single commit, and lets the layout effect below make the one follow or
   * anchor correction. Committing per measurement let each height change move
   * the scroll geometry while the rest of the batch was still arriving.
   */
  const applyPending = useCallback(() => {
    flushHandle.current = null;
    const pending = pendingHeights.current;
    if (pending.size === 0) return;
    // The anchor describes the geometry that is still on screen, so it must be
    // read before the batch changes any offset.
    captureAnchor();
    for (const [key, height] of pending) {
      heights.current.set(key, height);
      fallback.current.delete(key);
    }
    pending.clear();
    measurementRevision.current += 1;
    flushSync(() => setTick(measurementRevision.current));
  }, [captureAnchor]);

  const measure = useCallback(
    (index: string, node: HTMLDivElement | null) => {
      if (!node) return;
      const height = node.getBoundingClientRect().height;
      if (height <= 0) return;
      if (heights.current.get(index) === height) {
        // The row returned to its settled height before the pass ran.
        pendingHeights.current.delete(index);
        return;
      }
      if (pendingHeights.current.get(index) === height) return;
      pendingHeights.current.set(index, height);
      if (flushHandle.current === null) flushHandle.current = requestAnimationFrame(applyPending);
    },
    [applyPending],
  );

  useEffect(
    () => () => {
      if (flushHandle.current !== null) cancelAnimationFrame(flushHandle.current);
      flushHandle.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewport(element.clientHeight);
      updateScrollFade(element);
    });
    observer.observe(element);
    setViewport(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const fittedRequest = useRef(false);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (loadingOlder) {
      fittedRequest.current = false;
      return;
    }
    // A loaded slice that still fits the viewport can never fire the scroll
    // handler below, so its top edge needs no gesture: keep loading until the
    // reader has something to scroll through or history runs out.
    if (!fittedRequest.current && shouldLoadOlderFitted(hasOlder, loadingOlder, element.scrollHeight, element.clientHeight)) {
      fittedRequest.current = true;
      onLoadOlder?.();
    }
  }, [revision, viewport, hasOlder, loadingOlder, onLoadOlder]);

  const keys = items.map(getKey);
  const { offsets, total, start, end } = buildLayoutWindow({
    keys,
    heights: heights.current,
    fallback: fallback.current,
    estimate,
    overscan,
    // An initializing list mounts the tail immediately; walking from the first
    // estimated rows to the last would expose the entire history while
    // measurements catch up.
    windowTop: initializing.current ? null : scrollTop,
    viewport,
  });
  const firstKey = keys.length ? keys[0]! : null;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const sentMessage = followedRequest.current !== followRequest;
    if (sentMessage) {
      followedRequest.current = followRequest;
      anchor.current = null;
      // The owner just acted: land on the new tail instead of gliding to it.
      // Easing here moved the typing dot under the reader's eyes.
      follower.current?.resume({ immediate: true });
    }
    if (initializing.current) {
      follower.current?.follow({ immediate: true });
      setScrollTop(element.scrollTop);
      // The flip waits until a pass has applied real measurements and nothing is
      // queued, so a transcript that is still settling is never placed and then
      // re-placed.
      if (items.length > 0 && revision > 0 && pendingHeights.current.size === 0 && viewport === element.clientHeight) {
        initializing.current = false;
        measurementRevision.current += 1;
        setTick(measurementRevision.current);
      }
    } else if (follower.current?.pinned !== false) {
      const previous = layout.current;
      // A footer that appears or disappears changes the content height in one
      // step (the typing dot is 46px tall); easing through it bobbed the dot.
      const footerChanged = previous !== null && footer !== previous.footer;
      // Streamed growth follows the same eased path as nested output. Adding
      // each measured height directly to scrollTop bypassed that motion.
      follower.current?.follow(footerChanged ? { immediate: true } : undefined);
    } else {
      if (!anchor.current) captureAnchor();
      if (anchor.current) {
        const index = items.findIndex((item) => getKey(item) === anchor.current?.key);
        const rows = element.querySelector<HTMLElement>('.rows');
        if (index >= 0 && rows) element.scrollTop = rows.offsetTop - element.offsetTop + offsets[index] + anchor.current.offset;
      }
    }
    layout.current = { keys, offsets, footer };
    updateScrollFade(element);
    anchor.current = null;
  }, [total, viewport, firstKey, items.length, followRequest, revision, footer]);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = scroller.current;
    if (!element) return;
    // React listens for scroll at the root, so a scroll inside a nested region
    // (a step list, a tool output) arrives here too. Only the transcript itself
    // may decide whether the transcript is pinned.
    if (event.target !== element) return;
    // Following the stream moves the transcript every frame; re-rendering the
    // list for every pixel of that drift is what made a phone fall behind, so a
    // scroll only counts once it is far enough to change which rows are shown.
    setScrollTop((previous) => (Math.abs(element.scrollTop - previous) >= 8 ? element.scrollTop : previous));
    // Reader gestures release the follow; returning to the bottom resumes it.
    // Layout-driven scroll events must not cancel automatic tracking.
    follower.current?.track();
    updateScrollFade(element);
    anchor.current = null;
    if (element.scrollTop < 240 && hasOlder && onLoadOlder && !loadingOlder) onLoadOlder();
  };

  return (
    <div
      className="scroller scroll-fade"
      data-scroll-viewport
      tabIndex={0}
      aria-label="Conversation"
      ref={scroller}
      onScroll={handleScroll}
    >
      {header}
      <div className="rows" style={{ height: total }}>
        {items.slice(start, end).map((item, offset) => {
          const index = start + offset;
          const key = keys[index]!;
          return (
            <MeasuredRow key={key} index={key} top={offsets[index]} measure={measure}>
              {render(item, index)}
            </MeasuredRow>
          );
        })}
      </div>
      {footer}
    </div>
  );
}
