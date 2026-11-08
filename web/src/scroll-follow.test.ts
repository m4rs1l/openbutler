import { describe, expect, it, vi } from 'vitest';
import { createScrollFollower } from './scroll-follow.js';

/** The shape the follower actually drives; the DOM around it is irrelevant here. */
interface ScrollNode {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
}

function fakeScroller(scrollHeight: number, clientHeight: number, clientWidth = 0) {
  const node: ScrollNode = { scrollTop: 0, scrollHeight, clientHeight, clientWidth };
  return { node, followerNode: node as unknown as HTMLElement };
}

function stubBrowser() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return frames;
}

describe('scroll follower', () => {
  it('closes a huge backlog in one step instead of chasing it frame by frame', () => {
    const frames = stubBrowser();
    const { node, followerNode } = fakeScroller(100_000, 800);
    const follower = createScrollFollower(followerNode);
    follower.follow();
    node.scrollTop = 39_200;
    follower.track();
    follower.follow();
    expect(node.scrollTop).toBe(99_200);
    expect(frames.length).toBe(0);
    vi.unstubAllGlobals();
  });

  it('snaps a glued reader on a viewport re-wrap, a clamp and a deliberate jump', () => {
    const frames = stubBrowser();
    const { node, followerNode } = fakeScroller(1_000, 400, 900);
    const follower = createScrollFollower(followerNode);
    // The first placement is history, not growth: it lands immediately.
    follower.follow();
    expect(node.scrollTop).toBe(600);
    // The viewport re-wrapped (resize): the box itself changed, so content
    // above re-wrapped. The correction must land with the commit that caused
    // it — exact, before paint — instead of popping down and easing back over
    // the next frames; that pop-and-return is what reads as trembling.
    node.clientWidth = 800;
    node.scrollHeight = 1_200;
    follower.follow();
    expect(node.scrollTop).toBe(800);
    expect(frames.length).toBe(0);
    // A height change (window or keyboard) is the same class of event.
    node.clientHeight = 300;
    follower.follow();
    expect(node.scrollTop).toBe(900);
    expect(frames.length).toBe(0);
    // A shrink clamps the reader; the same rule keeps them glued to the tail.
    node.scrollHeight = 900;
    follower.follow();
    expect(node.scrollTop).toBe(600);
    expect(frames.length).toBe(0);
    // A sent message is a deliberate jump: the reader must not watch the tail
    // glide, which is what made the typing dot bob.
    node.scrollHeight = 1_300;
    follower.resume({ immediate: true });
    expect(node.scrollTop).toBe(1_000);
    vi.unstubAllGlobals();
  });

  it('eases streamed growth under an unchanged box instead of snapping to it', () => {
    const frames = stubBrowser();
    const { node, followerNode } = fakeScroller(1_000, 400, 900);
    const follower = createScrollFollower(followerNode);
    follower.follow();
    expect(node.scrollTop).toBe(600);
    // Rows stream in: the box is untouched, only the tail moved. This is the
    // glide the reader watches — scheduling it again must not snap.
    node.scrollHeight = 1_120;
    follower.follow();
    expect(node.scrollTop).toBe(600);
    expect(frames.length).toBe(1);
    const before = node.scrollTop;
    frames.shift()!(performance.now() + 16);
    expect(node.scrollTop).toBeGreaterThan(before);
    expect(node.scrollTop).toBeLessThan(720);
    // More growth retargets the running frame instead of adding a second one.
    node.scrollHeight = 1_200;
    follower.follow();
    expect(frames.length).toBe(1);
    vi.unstubAllGlobals();
  });

  it('keeps easing when the reader was already away from the tail', () => {
    const frames = stubBrowser();
    const { node, followerNode } = fakeScroller(1_000, 400);
    const follower = createScrollFollower(followerNode);
    follower.follow();
    // The reader sits 200px above the tail (a nested area owns their gesture).
    node.scrollTop = 400;
    follower.track();
    node.scrollHeight = 1_100;
    follower.follow();
    expect(frames.length).toBe(1);
    const before = node.scrollTop;
    frames.shift()!(performance.now() + 16);
    expect(node.scrollTop).toBeGreaterThan(before);
    expect(node.scrollTop).toBeLessThan(700);
    vi.unstubAllGlobals();
  });
});
