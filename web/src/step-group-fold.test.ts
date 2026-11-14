import { describe, expect, it } from 'vitest';
import { stepGroupOpenState, stretchAnswered, type TurnGroup } from './turns.js';
import type { Entry } from './types.js';

const user = (text: string): Entry => ({ kind: 'user', text, turnId: 't' });
const assistant = (text: string): Entry => ({ kind: 'assistant', text, turnId: 't' });
const tool = (): Entry => ({ kind: 'tool', text: 'tool ran', turnId: 't' });
const steps = (...entries: Entry[]): TurnGroup => ({ kind: 'steps', entries });
const message = (entry: Entry): TurnGroup => ({ kind: 'message', entry });
const divider: TurnGroup = { kind: 'divider', entry: { kind: 'divider', text: 'day break', turnId: 't' } };
const compaction: TurnGroup = { kind: 'compaction', entry: { kind: 'compaction', text: 'checkpoint', turnId: 't' } };

describe('stretchAnswered', () => {
  it('reports false when the owner message follows the stretch', () => {
    const groups = [steps(tool()), message(user('next ask'))];
    expect(stretchAnswered(groups, 0)).toBe(false);
  });

  it('reports true when an assistant answer follows the stretch', () => {
    const groups = [steps(tool()), message(assistant('the reply'))];
    expect(stretchAnswered(groups, 0)).toBe(true);
  });

  it('stops at the owner message so an answer after it belongs to the next stretch', () => {
    const groups = [steps(tool()), message(user('steered ask')), steps(tool()), message(assistant('later reply'))];
    expect(stretchAnswered(groups, 0)).toBe(false);
    expect(stretchAnswered(groups, 2)).toBe(true);
  });

  it('reports false when the stretch runs to the end of the turn unanswered', () => {
    expect(stretchAnswered([steps(tool())], 0)).toBe(false);
  });

  it('keeps scanning across divider and compaction boundaries', () => {
    expect(stretchAnswered([steps(tool()), divider, compaction, message(assistant('reply'))], 0)).toBe(true);
    expect(stretchAnswered([steps(tool()), divider, message(user('next ask'))], 0)).toBe(false);
  });
});

describe('stepGroupOpenState', () => {
  const activeState = { wasActive: true, active: true, automatic: true, open: true };

  it('keeps an automatically opened group open when activity leaves an unanswered stretch', () => {
    // The owner steers the next message into a tools-only stretch: the work
    // under discussion must not vanish the moment the new group starts.
    expect(stepGroupOpenState({ ...activeState, active: false }, false)).toEqual({
      wasActive: false,
      automatic: true,
      open: true,
    });
  });

  it('folds an automatically opened group once an answer follows the stretch', () => {
    expect(stepGroupOpenState({ ...activeState, active: false }, true)).toEqual({
      wasActive: false,
      automatic: false,
      open: false,
    });
  });

  it('leaves a reader-opened group open when activity moves on without an answer', () => {
    expect(stepGroupOpenState({ wasActive: true, active: false, automatic: false, open: true }, false)).toEqual({
      wasActive: false,
      automatic: false,
      open: true,
    });
  });

  it('leaves a reader-closed group closed when activity moves on', () => {
    expect(stepGroupOpenState({ wasActive: true, active: false, automatic: false, open: false }, true)).toEqual({
      wasActive: false,
      automatic: false,
      open: false,
    });
  });

  it('opens a group automatically when it becomes active', () => {
    expect(stepGroupOpenState({ wasActive: false, active: true, automatic: false, open: false }, false)).toEqual({
      wasActive: true,
      automatic: true,
      open: true,
    });
  });

  it('returns the state untouched while activity is unchanged', () => {
    const state = { wasActive: true, active: true, automatic: true, open: true };
    expect(stepGroupOpenState(state, false)).toBe(state);
  });
});
