import type { ToolDefinition } from './registry.js';

const sessionNewEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
} as const;

const MAX_INSTRUCTION_CHARS = 8_000;

/**
 * The custodian's way to start a durable chat. Creation is its own verb: a
 * message needs a recipient, a session needs an identity, a scope and a first
 * turn. Only the custodian runtime is given this tool, so no chat and no worker
 * can open one; the host owns the scope (the machine's configured workspace, the
 * same one a bare chat opens in), the model and the approval mode, which is why
 * none of them is a parameter here. The created session lands in the ordinary
 * chat list, so this is not a way to move work out of the owner's sight.
 */
export function createSessionNewTool(
  create: (input: { instruction: string }, senderSessionId: string | undefined) => Promise<unknown> | unknown,
): ToolDefinition {
  return {
    providerId: 'host',
    name: 'session_new',
    description: `Start a durable chat on this machine and give it its first instruction. The new session starts in this machine's configured workspace, with the machine's default chat model and approval mode; none of those can be set here. Its first turn is the instruction, so write it as a complete task for a stranger: what to achieve, the constraints, and what a finished result looks like. The call returns at once with the new session id; the work continues in that session, which reports back to you with custodian_message. Use subagent instead for a one-shot task that should die when it is done; use this for work that deserves a conversation the owner can open and continue. At most ${MAX_INSTRUCTION_CHARS} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: `The new session's first instruction, at most ${MAX_INSTRUCTION_CHARS} characters.`,
        },
      },
      required: ['instruction'],
      additionalProperties: false,
    },
    effect: sessionNewEffect,
    autoApprove: () => true,
    execute: async (input, _signal, context) => {
      const instruction = typeof input.instruction === 'string' ? input.instruction : '';
      if (!instruction.trim() || instruction.length > MAX_INSTRUCTION_CHARS) {
        return { status: 'invalid', error: `instruction must be non-empty and at most ${MAX_INSTRUCTION_CHARS} characters.` };
      }
      try {
        return await create({ instruction }, context?.sessionId);
      } catch (error) {
        return { status: 'error', error: `The session could not be created: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
