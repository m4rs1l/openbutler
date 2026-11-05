import type { Project, SessionInfo } from './types.js';

export interface ProjectGroup {
  project: Project;
  sessions: SessionInfo[];
}

export interface SidebarGroups {
  /** Catalog order: the sidebar never reorders projects by chat activity. */
  projects: ProjectGroup[];
  /** Chats with no bound project. A chat bound to a project appears only there. */
  recent: SessionInfo[];
}

/** Chats shown under one project before "Show more". */
export const PROJECT_CHATS_VISIBLE = 5;

/**
 * The one projection the sidebar renders from. A chat belongs to the project
 * the host bound it to; a binding whose project is no longer in the catalog is
 * still a reachable chat, so it falls back to Recent instead of disappearing.
 */
export function groupSessionsByProject(sessions: readonly SessionInfo[], projects: readonly Project[]): SidebarGroups {
  const groups: ProjectGroup[] = projects.map((project) => ({ project, sessions: [] }));
  const byId = new Map(groups.map((group) => [group.project.id, group]));
  const recent: SessionInfo[] = [];
  for (const session of sessions) {
    const group = session.project?.id ? byId.get(session.project.id) : undefined;
    if (group) group.sessions.push(session);
    else recent.push(session);
  }
  return { projects: groups, recent };
}
