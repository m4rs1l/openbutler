import type { SessionInfo } from '../types.js';
import { OverflowMarquee } from './selection/overflow-marquee.js';

/**
 * One chat row. Recent and a project's children render the same component, so a
 * chat never behaves differently depending on which section lists it.
 */
export function SessionRow({
  session,
  currentId,
  disabled,
  disabledReason,
  onSelect,
}: {
  session: SessionInfo;
  currentId?: string;
  disabled: boolean;
  disabledReason?: string;
  onSelect: (id: string) => void;
}) {
  const current = session.id === currentId;
  return (
    <button
      type="button"
      className={`session-item${current ? ' current' : ''}`}
      aria-current={current ? 'page' : undefined}
      disabled={disabled}
      title={disabled ? disabledReason : session.preview || session.title}
      onClick={() => onSelect(session.id)}
    >
      <span className="session-name">
        <OverflowMarquee>{session.title || 'New chat'}</OverflowMarquee>
      </span>
      {session.running ? <span className="session-running" role="img" aria-label="Agent running" title="Agent running" /> : null}
    </button>
  );
}
