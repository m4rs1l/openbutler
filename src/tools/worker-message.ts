import type { ToolDefinition } from './registry.js';

const workerMessageEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
} as const;

const MAX_WORKER_MESSAGE_CHARS = 2_000;

/**
 * Steering a live worker. The name is the addressee, and the host decides who
 * may be named: the custodian may message any live worker, and every other
 * sender only a worker it spawned. A worker that is not running cannot be
 * addressed at all - it died when its run ended, and there is nothing to resume.
 */
export function createWorkerMessageTool(
  send: (input: { session: string; text: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown,
): ToolDefinition {
  return {
    providerId: 'host',
    name: 'worker_message',
    description: `Send a short text message into a live worker session (steering). The custodian may address any running worker; any other session may address only a worker it started. The receiver is told the text comes from another OpenButler agent that cannot approve or change settings. Use it to redirect or correct work in progress; read the worker first with session_read when its state is unclear. A finished worker cannot be messaged: it ran once and is gone. Text only, at most ${MAX_WORKER_MESSAGE_CHARS} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Full worker session id or a unique prefix of at least four hex characters.',
        },
        text: { type: 'string', description: `The message to deliver, at most ${MAX_WORKER_MESSAGE_CHARS} characters.` },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
    effect: workerMessageEffect,
    autoApprove: () => true,
    execute: async (input, _signal, context) => {
      const session = typeof input.session === 'string' ? input.session.trim() : '';
      const text = typeof input.text === 'string' ? input.text : '';
      if (!session || session.length > 64) return { status: 'invalid', error: 'session must be a non-empty session id or prefix.' };
      if (!text.trim() || text.length > MAX_WORKER_MESSAGE_CHARS) {
        return { status: 'invalid', error: `text must be non-empty and at most ${MAX_WORKER_MESSAGE_CHARS} characters.` };
      }
      try {
        return await send({ session, text }, context?.sessionId);
      } catch (error) {
        return { status: 'error', error: `The message could not be delivered: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
