import { describe, expect, it, vi } from 'vitest';
import { AgentInbox, inboxNotice, type InboxSource } from '../src/inbox.js';
import { createInboxTool } from '../src/tools/inbox.js';
import { ownerInboxToolResultToModelMessages, summarizeOwnerInboxToolResult } from '../src/image.js';

function source(name: string, references = ['first', 'second']): InboxSource {
  const opened = new Set<string>();
  return {
    name,
    list: async () => ({
      items: references
        .filter((id) => !opened.has(id))
        .map((reference, index) => ({
          reference,
          receivedAt: `2026-10-18T00:00:0${index}Z`,
          state: opened.has(reference) ? 'read' : 'unread',
        })),
    }),
    // Opening is consuming: no second step exists.
    read: vi.fn(async (ids: readonly string[], sessionId: string) =>
      ids.map((reference) => {
        opened.add(reference);
        return { reference, content: { text: `content:${name}:${reference}`, reader: sessionId } };
      }),
    ),
  };
}

describe('one extensible agent inbox', () => {
  it('merges sources without exposing payloads or consuming notifications on list', async () => {
    const inbox = new AgentInbox();
    for (const name of ['Telegram', 'Team', 'Subagent', 'Calendar']) inbox.register(source(name, ['one']));
    const first = await inbox.execute({ action: 'list' }, 'parent');
    expect(first).toMatchObject({
      sources: [
        { source: 'Telegram', unread: 1 },
        { source: 'Team', unread: 1 },
        { source: 'Subagent', unread: 1 },
        { source: 'Calendar', unread: 1 },
      ],
      items: expect.any(Array),
    });
    expect(JSON.stringify(first)).not.toContain('content:');
    expect(await inbox.execute({ action: 'list' }, 'parent')).toEqual(first);
    expect(inboxNotice('Calendar', 1)).toBe('You have 1 "Calendar" notification. Use inbox to read.');
  });

  it('opens a notification by its short code and removes it from the box', async () => {
    const inbox = new AgentInbox();
    const backend = source('Team');
    inbox.register(backend);
    const first = (await inbox.execute({ action: 'list' }, 'parent')) as { items: Array<{ id: string }> };
    // A code, not a uuid: six Crockford characters a model can copy.
    expect(first.items[0]!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    await inbox.execute({ action: 'read', ids: [first.items[0]!.id] }, 'parent');
    expect(await inbox.execute({ action: 'list' }, 'another-chat')).toMatchObject({
      sources: [{ count: 1, unread: 1 }],
    });
    // Reading was the consumption: the source owns no second step to call.
    expect(backend).not.toHaveProperty('acknowledge');
    expect(backend.read).toHaveBeenCalledWith(['first'], 'parent');
  });

  it('refuses to read without ids and keeps each source read batched', async () => {
    const inbox = new AgentInbox();
    const backend = source('Telegram');
    inbox.register(backend);
    // Choosing what to open is the reader's job: a bare read would consume a page
    // the model never looked at.
    expect(await inbox.execute({ action: 'read' }, 'parent')).toMatchObject({ status: 'invalid' });
    expect(backend.read).not.toHaveBeenCalled();
    const listed = (await inbox.execute({ action: 'list' }, 'parent')) as { items: Array<{ id: string }> };
    await inbox.execute({ action: 'read', ids: listed.items.map((item) => item.id) }, 'parent');
    expect(backend.read).toHaveBeenCalledWith(['first', 'second'], 'parent');
  });

  it('paginates metadata, filters arbitrary sources and opens a listed code', async () => {
    const inbox = new AgentInbox();
    const backend = source('A source', ['ref:with / characters', 'second']);
    inbox.register(backend);
    const listed = (await inbox.execute({ action: 'list', source: 'A source', offset: 1, limit: 1 }, 'parent')) as {
      items: Array<{ id: string }>;
      remaining: number;
    };
    expect(listed.remaining).toBe(0);
    expect(listed.items).toHaveLength(1);
    await inbox.execute({ action: 'read', ids: [listed.items[0]!.id] }, 'parent');
    expect(backend.read).toHaveBeenCalledWith(['second'], 'parent');
  });

  it('reports the notifications a source has not listed yet', async () => {
    const inbox = new AgentInbox();
    inbox.register({
      name: 'Paged',
      list: async () => ({
        items: [
          { reference: 'one', receivedAt: '2026-10-18T10:00:00.000Z', state: 'unread' },
          { reference: 'two', receivedAt: '2026-10-18T10:01:00.000Z', state: 'unread' },
        ],
        remaining: 5,
      }),
      read: async () => [],
    });
    // Seven notifications exist, the source lists two; a large limit must not claim the rest are gone.
    expect(await inbox.execute({ action: 'list', limit: 20 }, 'parent')).toMatchObject({ remaining: 5 });
    expect(await inbox.execute({ action: 'list', offset: 1, limit: 20 }, 'parent')).toMatchObject({ remaining: 5 });
  });

  it('keeps healthy sources available while surfacing failures', async () => {
    const inbox = new AgentInbox();
    inbox.register({
      ...source('Offline'),
      list: async () => {
        throw new Error('offline');
      },
    });
    inbox.register(source('Telegram', ['one']));
    expect(await inbox.execute({ action: 'list' }, 'parent')).toMatchObject({
      items: [{ source: 'Telegram' }],
      errors: [{ source: 'Offline', error: 'offline' }],
    });
  });

  it('opens only codes a current listing produced, never a raw reference', async () => {
    const inbox = new AgentInbox();
    const backend = source('Team');
    inbox.register(backend);
    // A code names a pending notification; a reference, a prefix or an opaque id
    // is not something the reader can invent, so nothing reaches a backend.
    for (const ids of [['Team:first'], ['no-prefix'], ['first'], ['Team:%xx']])
      expect(await inbox.execute({ action: 'read', ids }, 'parent')).toMatchObject({ status: 'invalid' });
    expect(await inbox.execute({ action: 'read', ids: ['first'] }, undefined)).toMatchObject({ status: 'denied' });
    expect(backend.read).not.toHaveBeenCalled();
    expect(() => inbox.register(backend)).toThrow('already registered');
  });

  it('names each pending notification by sender, subject and time without the body', async () => {
    const inbox = new AgentInbox();
    inbox.register({
      name: 'Agent',
      list: async () => ({
        items: [
          { reference: 'r1', receivedAt: '2026-10-18T10:00:00.000Z', state: 'unread', from: 'a1b2c3d4', subject: 'Refactor dashrip' },
        ],
      }),
      read: async () => [],
    });
    expect(await inbox.execute({ action: 'list' }, 'parent')).toMatchObject({
      items: [{ source: 'Agent', receivedAt: '2026-10-18T10:00:00.000Z', from: 'a1b2c3d4', subject: 'Refactor dashrip' }],
    });
  });

  it('keeps a code stable for a notification the reader has already listed', async () => {
    const inbox = new AgentInbox();
    let items = [{ reference: 'old', receivedAt: '2026-10-18T10:00:00.000Z', state: 'unread' as const }];
    inbox.register({ name: 'Agent', list: async () => ({ items }), read: async () => [] });
    const before = (await inbox.execute({ action: 'list' }, 'parent')) as { items: Array<{ id: string }> };
    items = [...items, { reference: 'new', receivedAt: '2026-10-18T10:05:00.000Z', state: 'unread' as const }];
    const after = (await inbox.execute({ action: 'list' }, 'parent')) as { items: Array<{ id: string }> };
    // Codes are assigned oldest first, so a newer arrival can only take a free code.
    expect(after.items[0]!.id).toBe(before.items[0]!.id);
  });

  it('reports the ids it could not open and still opens the rest', async () => {
    const inbox = new AgentInbox();
    const backend = source('Subagent', ['child']);
    inbox.register(backend);
    const listed = (await inbox.execute({ action: 'list' }, 'parent')) as { items: Array<{ id: string }> };
    const result = await inbox.execute({ action: 'read', ids: [listed.items[0]!.id, 'ZZZZZZ'] }, 'parent');
    expect(result).toMatchObject({ status: 'partial', unresolved: ['ZZZZZZ'], items: [{ source: 'Subagent' }] });
    expect(backend.read).toHaveBeenCalledWith(['child'], 'parent');
    expect(await inbox.execute({ action: 'read', ids: ['ZZZZZZ'] }, 'parent')).toMatchObject({ status: 'invalid' });
    expect(backend.read).toHaveBeenCalledTimes(1);
  });

  it('validates the single tool contract and preserves the caller identity', async () => {
    const execute = vi.fn(async () => ({ status: 'ok' }));
    const tool = createInboxTool(execute);
    await tool.execute({ action: 'read', ids: ['Subagent:child'] }, undefined, { sessionId: 'parent' });
    expect(execute).toHaveBeenCalledWith({ action: 'read', ids: ['Subagent:child'] }, 'parent');
    for (const input of [
      {},
      { action: 'acknowledge' },
      { action: 'read', ids: [] },
      { action: 'list', limit: 21 },
      { action: 'list', offset: -1 },
    ])
      expect(await tool.execute(input)).toMatchObject({ status: 'invalid' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('opens a notification named by id when the model cannot send an array', async () => {
    const execute = vi.fn(async () => ({ status: 'ok' }));
    const tool = createInboxTool(execute);
    // A model that cannot produce an array still has to reach the notification:
    // the id travels as a plain string, and a string in the array slot is read
    // the same way. One lost array must not leave a notification unreadable.
    await tool.execute({ action: 'read', id: 'AH2SFY' }, undefined, { sessionId: 'parent' });
    expect(execute).toHaveBeenCalledWith({ action: 'read', ids: ['AH2SFY'] }, 'parent');
    await tool.execute({ action: 'read', ids: 'AH2SFY' }, undefined, { sessionId: 'parent' });
    expect(execute).toHaveBeenLastCalledWith({ action: 'read', ids: ['AH2SFY'] }, 'parent');
    await tool.execute({ action: 'read', id: 'AH2SFY,BG3TGZ' }, undefined, { sessionId: 'parent' });
    expect(execute).toHaveBeenLastCalledWith({ action: 'read', ids: ['AH2SFY', 'BG3TGZ'] }, 'parent');
    await tool.execute({ action: 'read', id: 'AH2SFY, BG3TGZ' }, undefined, { sessionId: 'parent' });
    expect(execute).toHaveBeenLastCalledWith({ action: 'read', ids: ['AH2SFY', 'BG3TGZ'] }, 'parent');
    // Reading still needs a name, and a list still needs none.
    expect(await tool.execute({ action: 'read' })).toMatchObject({ status: 'invalid' });
    await tool.execute({ action: 'list' }, undefined, { sessionId: 'parent' });
    expect(execute).toHaveBeenLastCalledWith({ action: 'list' }, 'parent');
  });

  it('preserves mixed source content while promoting only authenticated owner messages', () => {
    const output = {
      type: 'inbox',
      items: [
        {
          id: 'Telegram:one',
          source: 'Telegram',
          content: {
            type: 'owner-inbox',
            messages: [{ id: 'one', source: 'telegram', receivedAt: '2026-10-18T00:00:00Z', text: 'OWNER_REQUEST' }],
          },
        },
        { id: 'Team:one', source: 'Team', content: { text: 'PEER_REPORT' } },
        { id: 'Subagent:one', source: 'Subagent', content: { report: 'WORKER_REPORT', completionRevision: 2, session: 'one' } },
      ],
    };
    const userMessages = ownerInboxToolResultToModelMessages(output);
    expect(userMessages).toHaveLength(1);
    expect(JSON.stringify(userMessages)).toContain('OWNER_REQUEST');
    expect(JSON.stringify(userMessages)).not.toContain('PEER_REPORT');
    const summary = summarizeOwnerInboxToolResult(output)!;
    expect(summary).toContain('PEER_REPORT');
    expect(summary).toContain('WORKER_REPORT');
    expect(summary).not.toContain('OWNER_REQUEST');
  });
});
