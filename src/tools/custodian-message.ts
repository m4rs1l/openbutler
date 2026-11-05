import type { ToolDefinition } from './registry.js';

const custodianMessageEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
} as const;

const MAX_CUSTODIAN_MESSAGE_CHARS = 2_000;

/**
 * A session's only way to reach the machine's head. The name is the addressee:
 * there is one custodian, so there is no target parameter and no way to address
 * anything else. The host enforces that the sender is a session (not a worker,
 * which reports to its own parent) and stores the text as a durable record in
 * the custodian's inbox; the receiver sees it as a message from another
 * OpenButler agent, never as an owner instruction.
 *
 * The kind is part of the message because only the sender knows whether its work
 * is finished. A host that inferred it would put words in the head's mouth, and
 * a head that guessed would tell the owner that unfinished work is done.
 */
export function createCustodianMessageTool(
  send: (input: { text: string; kind: 'progress' | 'result' }, senderSessionId: string | undefined) => Promise<unknown> | unknown,
): ToolDefinition {
  return {
    providerId: 'host',
    name: 'custodian_message',
    description: `Send a short message to the machine custodian: a report, a needed decision, or a question it should see. It becomes a durable record in the custodian's inbox, so it survives a restart and is read when the custodian chooses; the text is framed as coming from this session, never from the owner, and it cannot approve actions or change settings. Say which kind it is: result means the work is finished and the owner may be told; progress means context that may still change. Report what is established, what is still in progress, and what you need; do not narrate routine progress or send acknowledgements. Text only, at most ${MAX_CUSTODIAN_MESSAGE_CHARS} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: `The message to deliver, at most ${MAX_CUSTODIAN_MESSAGE_CHARS} characters.` },
        kind: {
          type: 'string',
          enum: ['progress', 'result'],
          description: 'result: the work is finished and the owner may be told. progress: context only, still in progress, may change.',
        },
      },
      required: ['text', 'kind'],
      additionalProperties: false,
    },
    effect: custodianMessageEffect,
    autoApprove: () => true,
    execute: async (input, _signal, context) => {
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text.trim() || text.length > MAX_CUSTODIAN_MESSAGE_CHARS) {
        return { status: 'invalid', error: `text must be non-empty and at most ${MAX_CUSTODIAN_MESSAGE_CHARS} characters.` };
      }
      if (input.kind !== 'progress' && input.kind !== 'result') {
        return { status: 'invalid', error: 'kind must be progress or result: only the sender knows whether the work is finished.' };
      }
      try {
        return await send({ text, kind: input.kind }, context?.sessionId);
      } catch (error) {
        return { status: 'error', error: `The message could not be delivered: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
