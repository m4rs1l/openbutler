import { describe, expect, it, vi } from 'vitest';
import { createCustodianMessageTool } from '../src/tools/custodian-message.js';

describe('custodian_message', () => {
  it('asks the sender to say whether the work is finished', () => {
    const tool = createCustodianMessageTool(() => ({ status: 'delivered' }));
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    // Only the sender knows this; a host that inferred it would put words in the
    // head's mouth, and a head that guessed would call unfinished work done.
    expect(Object.keys(schema.properties ?? {})).toEqual(['text', 'kind']);
    expect(schema.required).toEqual(['text', 'kind']);
  });

  it('refuses a message without a kind and delivers a typed one', async () => {
    const send = vi.fn(() => ({ status: 'delivered' }));
    const typed = createCustodianMessageTool(send);
    expect(await typed.execute!({ text: 'Refactor finished.' }, undefined, { sessionId: 'chat-1' } as never)).toMatchObject({
      status: 'invalid',
    });
    expect(await typed.execute!({ text: 'Refactor finished.', kind: 'done' }, undefined, { sessionId: 'chat-1' } as never)).toMatchObject({
      status: 'invalid',
    });
    expect(send).not.toHaveBeenCalled();
    expect(await typed.execute!({ text: 'Refactor finished.', kind: 'result' }, undefined, { sessionId: 'chat-1' } as never)).toMatchObject(
      {
        status: 'delivered',
      },
    );
    expect(send).toHaveBeenCalledWith({ text: 'Refactor finished.', kind: 'result' }, 'chat-1');
  });
});
