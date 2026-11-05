import { useState } from 'react';
import { Icon } from '../components/icon.js';
import { Popover } from '../components/popover.js';
import { SessionRow } from '../components/session-row.js';
import { OverflowMarquee } from '../components/selection/overflow-marquee.js';
import { Button, IconButton } from '../components/ui.js';
import { PROJECT_CHATS_VISIBLE } from '../sidebar-grouping.js';
import type { Project, SessionInfo } from '../types.js';
import './projects.css';

/**
 * A project and its chats: the row selects the project, the "…" card carries
 * its facts (chat count, folder, edit), and the children are the chats the
 * host bound to it. Collapsing the whole section is the header's job, so a
 * project always shows what belongs to it.
 */
export function ProjectGroup({
  project,
  sessions,
  selected,
  selectDisabled,
  navigationDisabled,
  disabledReason,
  currentId,
  onSelectProject,
  onSelectSession,
  onEditProject,
}: {
  project: Project;
  sessions: SessionInfo[];
  selected: boolean;
  selectDisabled: boolean;
  navigationDisabled: boolean;
  disabledReason?: string;
  currentId?: string;
  onSelectProject: (id: string) => void;
  onSelectSession: (id: string) => void;
  onEditProject: (project: Project) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? sessions : sessions.slice(0, PROJECT_CHATS_VISIBLE);
  return (
    <div className="project">
      {/* The wrap owns the row's visual pill, so its actions sit inside it. */}
      <div className={`project-row-wrap${selected ? ' is-selected' : ''}`}>
        <button
          type="button"
          className="project-row"
          title={project.available ? project.folders.join('\n') : 'Source folder is unreachable'}
          aria-pressed={selected}
          disabled={!project.available || selectDisabled}
          onClick={() => onSelectProject(project.id)}
        >
          <Icon name="folder-open" />
          <span className="project-name">
            <OverflowMarquee>{project.name}</OverflowMarquee>
          </span>
        </button>
        <Popover
          className="project-card-pop"
          label={`Details for ${project.name}`}
          renderTrigger={({ open, toggle }) => (
            <IconButton
              icon="ellipsis"
              label={`Details for ${project.name}`}
              className="project-card-trigger"
              aria-expanded={open}
              aria-haspopup="dialog"
              onClick={toggle}
            />
          )}
        >
          {(close) => (
            <ProjectCard
              project={project}
              chatCount={sessions.length}
              onEdit={() => {
                close();
                onEditProject(project);
              }}
            />
          )}
        </Popover>
      </div>
      <div className="project-children">
        {visible.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            currentId={currentId}
            disabled={navigationDisabled}
            disabledReason={disabledReason}
            onSelect={onSelectSession}
          />
        ))}
        {sessions.length > PROJECT_CHATS_VISIBLE && !showAll ? (
          <Button className="show-more" onClick={() => setShowAll(true)}>
            Show more
          </Button>
        ) : null}
        {!sessions.length ? <p className="project-empty">No chats yet.</p> : null}
      </div>
    </div>
  );
}

/** The facts a project hover card shows; the name comes from the catalog, the
 *  path is metadata, and editing never re-derives one from the other. */
function ProjectCard({ project, chatCount, onEdit }: { project: Project; chatCount: number; onEdit: () => void }) {
  const [main, ...rest] = project.folders;
  return (
    <div className="project-card">
      <div className="project-card__head">
        <Icon name="folder" size={16} />
        <strong>{project.name}</strong>
      </div>
      <p className="project-card__meta">
        {chatCount} {chatCount === 1 ? 'chat' : 'chats'}
      </p>
      <p className="project-card__path" title={project.folders.join('\n')}>
        {main}
        {rest.length ? ` +${rest.length}` : ''}
      </p>
      <button type="button" className="project-card__action" onClick={onEdit}>
        <Icon name="settings" size={14} />
        Edit project
      </button>
    </div>
  );
}
