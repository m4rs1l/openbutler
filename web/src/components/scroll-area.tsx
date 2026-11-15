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
