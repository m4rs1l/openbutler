import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Stylesheet pinning lives in the root program: the web tsconfig declares no
// node types, and vitest's css:false replaces ?raw imports with an empty
// string. Same file-reading pattern as tests/conversation-welcome.test.ts.
function css(relative: string): string {
  return readFileSync(relative, 'utf8');
}

describe('action row stylesheet', () => {
  it('splits the bubble surface from the wrapper so the row lives outside it', () => {
    const styles = css('web/src/styles.css');
    const askRule = styles.match(/\.ask\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(askRule).toContain('fit-content');
    // The wrapper must stay surface-free or the row would sit on the bubble.
    expect(askRule).not.toMatch(/background|padding|border-radius/);
    const bubbleRule = styles.match(/\.ask-bubble\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(bubbleRule).toContain('9px 15px');
    expect(bubbleRule).toContain('#e8f3ff');
    expect(bubbleRule).toContain('18px');
  });

  it('pins the row geometry to the approved 20px minimal button', () => {
    const actions = css('web/src/components/message-actions.css');
    const buttonRule = actions.match(/\.message-actions button\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(buttonRule).toContain('width: 20px');
    expect(buttonRule).toContain('height: 20px');
    expect(buttonRule).toContain('border: 0');
    expect(buttonRule).toContain('color: #999ca4');
    const copiedRule = actions.match(/\.message-actions button\.copied\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(copiedRule).toContain('#3b7ef5');
  });

  it('reveals the user row on hover and focus, keeps the answer row always on', () => {
    const actions = css('web/src/components/message-actions.css');
    const askRowRule = actions.match(/\.ask \.message-actions\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(askRowRule).toContain('opacity: 0');
    expect(askRowRule).toContain('pointer-events: none');
    expect(askRowRule).toContain('justify-content: flex-end');
    expect(actions).toMatch(/\.ask:hover \.message-actions,\s*\.ask:focus-within \.message-actions\s*\{[^}]*opacity: 1/);
    const answerRowRule = actions.match(/\.answer \.message-actions\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(answerRowRule).toContain('margin-top: 7px');
    expect(answerRowRule).not.toContain('opacity');
  });

  it('keeps the row visible on touch devices that have no hover', () => {
    const actions = css('web/src/components/message-actions.css');
    const touchIndex = actions.indexOf('@media (hover: none)');
    expect(touchIndex).toBeGreaterThan(-1);
    const touch = actions.slice(touchIndex);
    expect(touch).toContain('.ask .message-actions');
    expect(touch).toMatch(/opacity:\s*1/);
  });
});
