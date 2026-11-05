import type { ToolDefinition } from './registry.js';

const sessionMessageEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
} as const;

const MAX_SESSION_MESSAGE_CHARS = 2_000;

/**
 * The custodian's way into a chat: it asks a question, steers, or relays an owner
 * instruction. The name is the addressee - a session - and only the custodian
 * runtime is given this tool, so no chat and no worker holds it. The host
 * decides which sessions exist and refuses the custodian's own id; the receiver
 * is told the text comes from another OpenButler agent that can never approve an
 * action or change a setting.
 */
export function createSessionMessageTool(
  send: (input: Record<string, unknown>, senderSessionId: string | undefined) => Promise<unknown> | unknown,
): ToolDefinition {
  return {
    providerId: 'host',
    name: 'session_message',
    description: `Send a short text message into a chat on this machine: a question, a correction, or an owner instruction the custodian is relaying. The session id is the chat's id; the chat is woken if it is idle, and the text lands in its own conversation. The receiver sees the text as a message from the OpenButler custodian, never from the owner, and it can never approve actions or change settings by itself. Read the session first with session_read when its state is unclear. Text only, at most ${MAX_SESSION_MESSAGE_CHARS} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Full session id or a unique prefix of at least four hex characters of a live worker session.',
        },
        text: { type: 'string', description: `The message to deliver, at most ${MAX_SESSION_MESSAGE_CHARS} characters.` },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
    effect: sessionMessageEffect,
    autoApprove: () => true,
    execute: async (input, _signal, context) => {
      const session = typeof input.session === 'string' ? input.session.trim() : '';
      const text = typeof input.text === 'string' ? input.text : '';
      if (!session || session.length > 64) {
        return { status: 'invalid', error: 'session must be a non-empty session id or prefix.' };
      }
      if (!text.trim() || text.length > MAX_SESSION_MESSAGE_CHARS) {
        return { status: 'invalid', error: `text must be non-empty and at most ${MAX_SESSION_MESSAGE_CHARS} characters.` };
      }
      try {
        return await send({ session, text }, context?.sessionId);
      } catch (error) {
        return {
          status: 'error',
          error: `The message could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
