import { describe, expect, it } from 'vitest';
import { groupSessionsByProject } from './sidebar-grouping.js';
import type { Project, SessionInfo } from './types.js';

function project(id: string, name: string): Project {
  return { id, name, folders: [`C:/code/${name}`], createdAt: '2026-10-31T00:00:00.000Z', available: true };
}

function chat(id: string, projectId?: string): SessionInfo {
  return {
    id,
    title: id,
    ...(projectId ? { project: { id: projectId, name: null, folders: [], workspaceRoot: 'C:/code', locked: true } } : {}),
  };
}

describe('sidebar project grouping', () => {
  it('puts a chat under the project the host bound it to and keeps catalog order', () => {
    const alpha = project('aaaaaaaa-0000-0000-0000-000000000000', 'Alpha');
    const beta = project('bbbbbbbb-0000-0000-0000-000000000000', 'Beta');
    const groups = groupSessionsByProject([chat('one', beta.id), chat('two', alpha.id), chat('three')], [alpha, beta]);
    expect(groups.projects.map((group) => group.project.name)).toEqual(['Alpha', 'Beta']);
    expect(groups.projects[0]!.sessions.map((session) => session.id)).toEqual(['two']);
    expect(groups.projects[1]!.sessions.map((session) => session.id)).toEqual(['one']);
    expect(groups.recent.map((session) => session.id)).toEqual(['three']);
  });

  it('lists every project even with no chats, so "no chats yet" has somewhere to render', () => {
    const groups = groupSessionsByProject([], [project('aaaaaaaa-0000-0000-0000-000000000000', 'Empty')]);
    expect(groups.projects).toHaveLength(1);
    expect(groups.projects[0]!.sessions).toEqual([]);
    expect(groups.recent).toEqual([]);
  });

  it('keeps a chat whose project no longer exists in Recent instead of hiding it', () => {
    const orphan = chat('orphan', 'cccccccc-0000-0000-0000-000000000000');
    const groups = groupSessionsByProject([orphan], [project('aaaaaaaa-0000-0000-0000-000000000000', 'Alpha')]);
    expect(groups.projects[0]!.sessions).toEqual([]);
    expect(groups.recent.map((session) => session.id)).toEqual(['orphan']);
  });

  it('treats an explicit null binding as project-less', () => {
    const unbound: SessionInfo = {
      id: 'unbound',
      title: 'unbound',
      project: { id: null, name: null, folders: [], workspaceRoot: 'C:/code', locked: false },
    };
    const groups = groupSessionsByProject([unbound], [project('aaaaaaaa-0000-0000-0000-000000000000', 'Alpha')]);
    expect(groups.projects[0]!.sessions).toEqual([]);
    expect(groups.recent.map((session) => session.id)).toEqual(['unbound']);
  });
});
