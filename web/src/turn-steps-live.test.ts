import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TurnView } from './turn.js';
import { buildTurns } from './turns.js';
import type { Entry } from './types.js';

const user: Entry = { kind: 'user', text: 'Task', turnId: 't' };
const tool = (at: number): Entry => ({
  kind: 'tool',
  tool: 'host:execute_command',
  command: 'ls',
  result: 'ok',
  running: true,
  turnId: 't',
  at,
});
const reasoning = (at: number): Entry => ({ kind: 'reasoning', text: 'live thought', turnId: 't', at });

function html(entries: Entry[], live = true): string {
  const [turn] = buildTurns(entries);
  if (!turn) throw new Error('expected turn');
  return renderToStaticMarkup(createElement(TurnView, { turn, live, sessionId: 's' }));
}

describe('live turn active group', () => {
  it('opens the live steps group even when a divider leads the work', () => {
    const log = html([user, { kind: 'divider', text: 'Model changed', turnId: 't', at: 1 }, tool(2), reasoning(3)]);
    expect(log).toContain('tool-group open');
  });

  it('opens the live steps group without a divider', () => {
    const log = html([user, tool(2), reasoning(3)]);
    expect(log).toContain('tool-group open');
  });

  it('folds the steps group once the run finishes', () => {
    const log = html([user, tool(2)], false);
    expect(log).not.toContain('tool-group open');
  });
});
