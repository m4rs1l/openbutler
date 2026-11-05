import { useState } from 'react';
import type { Project, SessionInfo, SessionPayload } from '../types.js';
import { Button, IconButton } from './ui.js';
import { Feedback } from './feedback.js';
import { SidebarHeader, SidebarFooter } from './sidebar-chrome.js';
import { SidebarSection } from './sidebar-section.js';
import { SessionRow } from './session-row.js';
import { ProjectGroup } from '../projects/project-group.js';
import { groupSessionsByProject } from '../sidebar-grouping.js';
import { readSections, saveSections, sectionsStorage, type SidebarSections } from '../sidebar-state.js';

/** Projects listed before "Show more"; the section itself collapses as a whole. */
const PROJECTS_VISIBLE = 5;

interface SidebarProps {
  inert?: boolean;
  sessions: SessionInfo[];
  current?: Pick<SessionPayload['session'], 'id' | 'title' | 'hasUserMessage' | 'project'>;
  projects: Project[];
  selectedProjectId: string | null;
  projectSelectionDisabled?: boolean;
  projectsLoading: boolean;
  projectsError: string | null;
  /** A project the host refused to open; shown where the projects are listed. */
  selectionError?: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onEditProject: (project: Project) => void;
  onRetryProjects: () => void;
  loading: boolean;
  error: boolean;
  disabled: boolean;
  disabledReason?: string;
  onSearch: () => void;
  onRetry: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  onSettings: () => void;
}

export function Sidebar(props: SidebarProps) {
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [sections, setSections] = useState<SidebarSections>(() => readSections(sectionsStorage()));
  const toggleSection = (key: keyof SidebarSections) => (open: boolean) => {
    const next = { ...sections, [key]: open };
    setSections(next);
    saveSections(sectionsStorage(), next);
  };
  // The store is the catalog: a chat without a message is not a row yet, so
  // the placeholder only appears once its first message has landed.
  const list: SessionInfo[] =
    props.current && props.current.hasUserMessage && !props.sessions.some((session) => session.id === props.current?.id)
      ? [{ ...props.current }, ...props.sessions]
      : props.sessions;
  const { projects: groups, recent } = groupSessionsByProject(list, props.projects);
  return (
    <aside id="sidebar-nav" className="sidebar sidebar-shell" aria-label="Conversations" inert={props.inert}>
      <SidebarHeader onSearch={props.onSearch} searchLabel="Search chats" onClose={props.onClose} />
      <Button className="new-chat" icon="square-pen" onClick={props.onNew} disabled={props.disabled} title={props.disabledReason}>
        New chat
      </Button>
      <div className="sidebar-scroll">
        <SidebarSection
          id="sidebar-section-projects"
          label="Projects"
          open={sections.projects}
          onToggle={toggleSection('projects')}
          actions={<IconButton icon="plus" label="New project" onClick={props.onCreateProject} />}
        >
          <div className="project-list">
            {groups.slice(0, showAllProjects ? undefined : PROJECTS_VISIBLE).map(({ project, sessions }) => (
              <ProjectGroup
                key={project.id}
                project={project}
                sessions={sessions}
                selected={project.id === props.selectedProjectId}
                selectDisabled={props.projectSelectionDisabled === true}
                navigationDisabled={props.disabled}
                disabledReason={props.disabledReason}
                currentId={props.current?.id}
                onSelectProject={props.onSelectProject}
                onSelectSession={props.onSelect}
                onEditProject={props.onEditProject}
              />
            ))}
            {props.projects.length > PROJECTS_VISIBLE && !showAllProjects ? (
              <Button className="show-more" onClick={() => setShowAllProjects(true)}>
                Show more
              </Button>
            ) : null}
            {props.projectsLoading && !props.projects.length ? (
              <Feedback tone="loading" layout="compact">
                Loading projects…
              </Feedback>
            ) : null}
            {props.projectsError ? (
              <Feedback tone="error" layout="compact" action={{ label: 'Try again', onClick: props.onRetryProjects }}>
                Projects could not be loaded.
              </Feedback>
            ) : null}
            {!props.projectsLoading && !props.projectsError && !props.projects.length ? (
              <Feedback layout="compact">No projects yet.</Feedback>
            ) : null}
            {props.selectionError ? (
              <Feedback tone="error" layout="compact">
                {props.selectionError}
              </Feedback>
            ) : null}
          </div>
        </SidebarSection>
        <SidebarSection id="sidebar-section-recent" label="Recent" open={sections.recent} onToggle={toggleSection('recent')}>
          <nav className="session-list" aria-label="Recent chats">
            {props.loading && !list.length ? (
              <Feedback tone="loading" layout="compact">
                Loading chats…
              </Feedback>
            ) : null}
            {props.error ? (
              <Feedback tone="error" layout="compact" action={{ label: 'Try again', onClick: props.onRetry }}>
                Chats could not be loaded.
              </Feedback>
            ) : null}
            {!props.loading && !props.error && !list.length ? <Feedback layout="compact">No chats yet.</Feedback> : null}
            {!props.loading && !props.error && !!list.length && !recent.length ? (
              <Feedback layout="compact">Every chat lives in a project.</Feedback>
            ) : null}
            {recent.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                currentId={props.current?.id}
                disabled={props.disabled}
                disabledReason={props.disabledReason}
                onSelect={props.onSelect}
              />
            ))}
          </nav>
        </SidebarSection>
      </div>
      {/* Settings stays reachable while a run is going; the page is read-only then. */}
      <SidebarFooter icon="settings" label="Settings" onClick={props.onSettings} />
    </aside>
  );
}
