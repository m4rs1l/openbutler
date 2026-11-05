import type { ToolDefinition } from './registry.js';

const approvalDecideEffect = {
  change: 'none',
  data: 'sensitive',
  network: 'none',
  reversible: 'full',
  outbound: 'model',
} as const;

/**
 * The custodian's decision on an approval a subordinate run is waiting for.
 *
 * Delegated approval needs a verb: a message can never approve anything, which
 * is exactly why this is a separate tool with a request id and a decision rather
 * than a sentence someone types. The host enforces that only the custodian may
 * call it, that no one decides their own request, and it records the decision
 * with its author, so a custodian decision is never written down as the owner's.
 */
export function createApprovalDecideTool(
  decide: (input: { requestId: string; decision: 'allow' | 'deny' }, senderSessionId: string | undefined) => unknown,
): ToolDefinition {
  return {
    providerId: 'host',
    name: 'approval_decide',
    description:
      'Decide an approval that a subordinate run is waiting for: allow the action, or deny it so the run closes with the blocked action named. Use the request id from the notification; the decision is recorded as yours, never as the owner\u2019s. Deny when the action is beyond what the run was given, when the input looks wrong, or when you cannot tell what it would do. You cannot decide your own approvals.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'The approval request id from the notification.' },
        decision: { type: 'string', enum: ['allow', 'deny'], description: 'allow runs the action once; deny refuses it.' },
      },
      required: ['requestId', 'decision'],
      additionalProperties: false,
    },
    effect: approvalDecideEffect,
    autoApprove: () => true,
    execute: async (input, _signal, context) => {
      const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
      const decision = input.decision;
      if (!requestId || requestId.length > 64) return { status: 'invalid', error: 'requestId must be a non-empty request id.' };
      if (decision !== 'allow' && decision !== 'deny') return { status: 'invalid', error: 'decision must be allow or deny.' };
      try {
        return decide({ requestId, decision }, context?.sessionId);
      } catch (error) {
        return { status: 'error', error: `The decision could not be applied: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
