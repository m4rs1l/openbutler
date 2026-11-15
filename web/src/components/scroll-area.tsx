import { useLayoutEffect, useRef, type HTMLAttributes } from 'react';
import { bindReaderGestures, createScrollFollower } from '../scroll-follow.js';

interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Keep the newest content in view while it grows. The follow stops the moment
   * the reader scrolls away and resumes when they return to the bottom, so a
   * streaming block never fights a reader who is looking at the start of it.
   */
  follow?: boolean;
}

/** Fade only edges that have more content beyond them. Shared with any
 * scroll viewport (the transcript) so the soft edge shadow is one definition. */
export function updateScrollFade(element: HTMLElement | null): void {
  if (!element) return;
  element.dataset.fadeTop = String(element.scrollTop > 1);
  element.dataset.fadeBottom = String(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
  element.dataset.fadeLeft = String(element.scrollLeft > 1);
  element.dataset.fadeRight = String(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
}

/** Wire the fade to scrolling and content growth for viewports that own their
 * own box (the markdown table region): one listener, one observer, same updater. */
export function bindScrollFade(element: HTMLElement | null): (() => void) | undefined {
  if (!element) return undefined;
  const update = () => updateScrollFade(element);
  element.addEventListener('scroll', update, { passive: true });
  const observer = new ResizeObserver(update);
  observer.observe(element);
  // A re-rendered table changes the scroll extent without resizing the region box.
  for (const child of Array.from(element.children)) observer.observe(child);
  update();
  return () => {
    observer.disconnect();
    element.removeEventListener('scroll', update);
  };
}

/** Fade only edges that have more content beyond them. */
export function ScrollArea({ className = '', children, follow = false, ...props }: ScrollAreaProps) {
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(follow);
  following.current = follow;

  useLayoutEffect(() => {
    const node = root.current;
    const inner = content.current;
    if (!node || !inner) return;
    const follower = createScrollFollower(node);
    const unbind = bindReaderGestures(node, follower);
    const fade = () => updateScrollFade(node);
    // Growth is the only signal that matters: text arrives without a scroll.
    const observer = new ResizeObserver(() => {
      if (following.current) follower.follow();
      fade();
    });
    observer.observe(node);
    observer.observe(inner);
    const onScroll = () => {
      follower.track();
      fade();
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    fade();
    return () => {
      observer.disconnect();
      node.removeEventListener('scroll', onScroll);
      unbind();
      follower.destroy();
    };
  }, []);

  return (
    <div {...props} ref={root} data-scroll-viewport className={`scroll-area scroll-fade ${className}`}>
      <div ref={content} className="scroll-area-content">
        {children}
      </div>
    </div>
  );
}
