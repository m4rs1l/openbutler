import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnView } from './turn.js';
import { buildTurns } from './turns.js';
import type { Entry } from './types.js';

const user = (text: string, turnOutcome?: Entry['turnOutcome']): Entry => ({
  kind: 'user',
  text,
  turnId: 't',
  ...(turnOutcome ? { turnOutcome } : {}),
});

const reasoning = (text: string, at: number, durationMs?: number): Entry => ({
  kind: 'reasoning',
  text,
  turnId: 't',
  at,
  ...(durationMs === undefined ? {} : { durationMs }),
});

describe('reasoning row mount state', () => {
  it('folds a finished thought the moment it is stamped, even mid-turn', () => {
    const [turn] = buildTurns([
      user('Task'),
      reasoning('earlier thought, already stamped', 1_000, 1_000),
      reasoning('latest thought, also finished', 2_000, 500),
    ]);
    if (!turn) throw new Error('expected turn');
    const html = renderToStaticMarkup(createElement(TurnView, { turn, live: true, sessionId: 's' }));
    // Both thoughts carry their duration: the run finished them, so neither stays
    // open just because the turn is still live. The duration is the sole signal.
    expect(html).not.toContain('<div class="step open">');
    expect(html.match(/<div class="step">/g) ?? []).toHaveLength(2);
  });

  it('keeps the thought being written open in a live turn', () => {
    const [turn] = buildTurns([user('Task'), reasoning('finished thought', 1_000, 1_000), reasoning('still writing', 2_000)]);
    if (!turn) throw new Error('expected turn');
    const html = renderToStaticMarkup(createElement(TurnView, { turn, live: true, sessionId: 's' }));
    const opens = html.match(/<div class="step open">/g) ?? [];
    const closed = html.match(/<div class="step">/g) ?? [];
    expect(opens).toHaveLength(1);
    expect(closed).toHaveLength(1);
  });

  it('closes every reasoning row in a finished turn, live or not', () => {
    const [turn] = buildTurns([user('Task', 'completed'), reasoning('done thought', 1_000, 500)]);
    if (!turn) throw new Error('expected turn');
    const html = renderToStaticMarkup(createElement(TurnView, { turn, live: false, sessionId: 's' }));
    expect(html).toContain('step-collapse" data-state="closed"');
    expect(html).not.toContain('<div class="step open">');
  });
});
