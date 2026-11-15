import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY_FEEDBACK_MS, MESSAGE_ACTIONS, MessageActions, copyIcon, copyLabel, copyMessageText } from './message-actions.js';
import { AssistantBubble, UserBubble } from './message-bubble.js';
import { TurnView } from '../turn.js';
import { buildTurns } from '../turns.js';
import type { Entry } from '../types.js';

function render(element: ReactNode): string {
  return renderToStaticMarkup(element);
}

const userEntry: Entry = { kind: 'user', text: 'Copy me', turnId: 't' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('message bubble structure', () => {
  it('places the copy row outside and below the user bubble surface', () => {
    const html = render(createElement(UserBubble, { entry: userEntry, sessionId: 's' }));
    // The blue surface ends before the row starts: no button can sit inside it.
    expect(html).toContain('<div class="ask"><div class="ask-bubble"><div class="prose">Copy me</div></div><div class="message-actions">');
    expect(html).toContain('aria-label="Copy"');
    expect(html).toContain('title="Copy"');
    expect(html).toContain('data-scroll-preserve');
  });

  it('shows the assistant row only when the call site marks the answer final', () => {
    const done = render(createElement(AssistantBubble, { text: 'Answer', showActions: true }));
    expect(done).toContain('<div class="answer"><div class="body">');
    expect(done).toContain('class="message-actions"');
    expect(done.indexOf('message-actions')).toBeGreaterThan(done.indexOf('class="body"'));
    // A work-log message never earns a row, streaming or not.
    const work = render(createElement(AssistantBubble, { text: 'Interim' }));
    expect(work).toContain('<div class="answer">');
    expect(work).not.toContain('message-actions');
    const gated = render(createElement(AssistantBubble, { text: 'Answer', showActions: false }));
    expect(gated).not.toContain('message-actions');
  });

  it('renders no row at all when the message has no text to copy', () => {
    const html = render(createElement(UserBubble, { entry: { kind: 'user', text: '   ', turnId: 't' }, sessionId: 's' }));
    expect(html).toContain('<div class="ask">');
    expect(html).not.toContain('message-actions');
  });

  it('wires both bubbles through TurnView and gates the answer row on the live turn', () => {
    const entries: Entry[] = [
      { kind: 'user', text: 'Task', turnId: 't' },
      { kind: 'assistant', text: 'Interim work', turnId: 't' },
      { kind: 'assistant', text: 'Answer', turnId: 't' },
    ];
    const [turn] = buildTurns(entries);
    const finished = render(createElement(TurnView, { turn, live: false, sessionId: 's' }));
    expect(finished).toContain('<div class="ask"><div class="ask-bubble"><div class="prose">Task</div></div>');
    // Only the ask and the final answer carry rows; the work log stays bare.
    const finishedRows = finished.match(/class="message-actions"/g)?.length ?? 0;
    expect(finishedRows).toBe(2);
    // While the answer streams, the work log is open yet carries no row, and
    // the final row waits for the stream to end.
    const live = render(createElement(TurnView, { turn, live: true, sessionId: 's' }));
    expect(live).toContain('Interim work');
    const liveRows = live.match(/class="message-actions"/g)?.length ?? 0;
    expect(liveRows).toBe(1);
  });
});

describe('copy behaviour', () => {
  it('writes the stored message source to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyMessageText('Copy me')).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('Copy me');
  });

  it('reports failure when the clipboard write rejects', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    expect(await copyMessageText('Copy me')).toBe('failed');
  });

  it('pins the label, glyph and feedback window for every status', () => {
    expect(copyLabel('idle')).toBe('Copy');
    expect(copyLabel('copied')).toBe('Copied');
    expect(copyLabel('failed')).toBe('Copy failed');
    expect(copyIcon('idle')).toBe('copy');
    expect(copyIcon('copied')).toBe('check');
    expect(copyIcon('failed')).toBe('copy');
    expect(COPY_FEEDBACK_MS).toBe(1_800);
  });

  it('draws the verified lucide copy glyph at rest, never the check', () => {
    const html = render(createElement(MessageActions, { text: 'Copy me' }));
    // lucide-react v0.577.0 copy path, read from web/node_modules.
    expect(html).toContain('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2');
    expect(html).not.toContain('M20 6 9 17l-5-5');
  });
});

describe('action registry', () => {
  it('renders no button when the caller asks for an empty action list', () => {
    const html = render(createElement(MessageActions, { text: 'Copy me', actions: [] }));
    expect(html).toContain('<div class="message-actions"></div>');
    expect(html).not.toContain('aria-label');
  });

  it('defaults the row to the registered copy action', () => {
    expect(Object.keys(MESSAGE_ACTIONS)).toEqual(['copy']);
    const fallback = render(createElement(MessageActions, { text: 'Copy me' }));
    const explicit = render(createElement(MessageActions, { text: 'Copy me', actions: ['copy'] }));
    expect(fallback).toBe(explicit);
    expect(explicit).toContain('aria-label="Copy"');
  });
});
