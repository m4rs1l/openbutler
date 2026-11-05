import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Project, SessionInfo } from '../types.js';
import { Sidebar } from './sidebar.js';

const noop = () => {};
const sessions: SessionInfo[] = [{ id: 'saved-1', title: 'Saved chat', preview: 'hello' }];
const voiceLab: Project = {
  id: 'aaaaaaaa-0000-0000-0000-000000000000',
  name: 'Voice Lab',
  folders: ['C:/code/voice-lab'],
  createdAt: '2026-10-31T00:00:00.000Z',
  available: true,
};
const boundChat: SessionInfo = {
  id: 'bound-1',
  title: 'Latency review',
  preview: 'codec drift',
  project: { id: voiceLab.id, name: 'Voice Lab', folders: voiceLab.folders, workspaceRoot: 'C:/code/voice-lab', locked: true },
};

function render(
  current?: { id: string; title: string; hasUserMessage?: boolean },
  list: SessionInfo[] = sessions,
  projects: Project[] = [],
) {
  const props = {
    sessions: list,
    current,
    projects,
    selectedProjectId: null,
    projectsLoading: false,
    projectsError: null,
    onSelectProject: noop,
    onCreateProject: noop,
    onEditProject: noop,
    onRetryProjects: noop,
    loading: false,
    error: false,
    disabled: false,
    onSearch: noop,
    onRetry: noop,
    onNew: noop,
    onSelect: noop,
    onClose: noop,
    onSettings: noop,
  };
  return renderToStaticMarkup(createElement(Sidebar, props));
}

describe('sidebar recent list', () => {
  it('does not show the open chat until its first message has landed', () => {
    const draft = render({ id: 'new-chat', title: 'New session', hasUserMessage: false });
    expect(draft).not.toContain('New session');
    expect(draft).toContain('Saved chat');

    const started = render({ id: 'new-chat', title: 'New session', hasUserMessage: true });
    expect(started).toContain('New session');
    expect(started.indexOf('New session')).toBeLessThan(started.indexOf('Saved chat'));
  });

  it('shows a listed chat without duplicating it', () => {
    const html = render({ id: 'saved-1', title: 'Saved chat', hasUserMessage: true });
    expect(html.match(/Saved chat/g)).toHaveLength(1);
  });
});

describe('sidebar project grouping', () => {
  it('lists a bound chat under its project and keeps it out of Recent', () => {
    const html = render(undefined, [boundChat, { id: 'saved-1', title: 'Saved chat' }], [voiceLab]);
    expect(html.match(/Latency review/g)).toHaveLength(1);
    expect(html.indexOf('Voice Lab')).toBeLessThan(html.indexOf('Latency review'));
    expect(html.indexOf('Saved chat')).toBeGreaterThan(html.indexOf('Latency review'));
  });

  it('says a project has no chats instead of leaving the space blank', () => {
    const html = render(undefined, [{ id: 'saved-1', title: 'Saved chat' }], [voiceLab]);
    expect(html).toContain('No chats yet.');
    expect(html).toContain('Saved chat');
  });

  it('exposes the project detail card action on the row', () => {
    const html = render(undefined, [boundChat], [voiceLab]);
    expect(html).toContain('Details for Voice Lab');
  });
});

describe('sidebar sections', () => {
  it('renders Projects and Recent as collapse toggles wired to their bodies', () => {
    const html = render();
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="sidebar-section-projects"');
    expect(html).toContain('aria-controls="sidebar-section-recent"');
  });

  it('keeps the new project action inside the Projects header', () => {
    const html = render();
    expect(html).toContain('aria-label="New project"');
  });
});
