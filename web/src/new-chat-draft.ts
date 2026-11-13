import type { ApprovalMode, ModelChoice, SessionPayload } from './types.js';

/** A browser-only draft. No daemon session exists until its first send. */
export interface NewChatDraft {
  sourceSessionId: string;
  projectId: string | null;
  model: ModelChoice | null;
  /** The effort picked before the host session exists; applied at materialization. */
  reasoningVariantId: string | null;
  approvalMode: ApprovalMode | null;
  creation: Promise<SessionPayload> | null;
}

export function newChatDraft(sourceSessionId: string, projectId: string | null): NewChatDraft {
  return { sourceSessionId, projectId, model: null, reasoningVariantId: null, approvalMode: null, creation: null };
}

/** The first send materializes the draft. Concurrent sends reuse the same request. */
export function materializeNewChat(
  draft: NewChatDraft,
  create: (sourceSessionId: string, projectId: string | null) => Promise<SessionPayload>,
): Promise<SessionPayload> {
  if (!draft.creation) {
    draft.creation = create(draft.sourceSessionId, draft.projectId).catch((error: unknown) => {
      draft.creation = null;
      throw error;
    });
  }
  return draft.creation;
}

/** A transient payload; it must never be sent to the daemon or session catalog. */
export function newChatPayload(previous: SessionPayload, projectId: string | null): SessionPayload {
  // The previous chat's runtime must never preview on a fresh draft: the selector
  // would show a model the first send will not run with. The draft starts blank;
  // the fresh defaults arrive from the server and fill it in.
  const workspaceRoot = previous.runtime?.workspaceRoot ?? '';
  return {
    reset: true,
    entries: [],
    updated: [],
    from: 0,
    totalEntries: 0,
    busy: false,
    runningTurnId: null,
    queuedMessageCount: 0,
    pendingApproval: null,
    pendingQuestion: null,
    runtime: { supportsSessionAttachments: true, workspaceRoot },
    ...(previous.buildId ? { buildId: previous.buildId } : {}),
    session: {
      id: 'new-chat',
      title: 'New session',
      hasUserMessage: false,
      ...(projectId
        ? {
            project: {
              id: projectId,
              name: null,
              folders: [],
              workspaceRoot: previous.runtime?.workspaceRoot ?? '',
              locked: false,
            },
          }
        : {}),
    },
  };
}
