import type { ReactNode } from 'react';
import { Collapsible } from './collapsible.js';
import { Icon } from './icon.js';

/**
 * One collapsible sidebar block: chevron heading, trailing actions, animated
 * body. Projects and Recent are both instances of this, so collapse behaviour,
 * spacing and accessibility cannot drift between sections.
 */
export function SidebarSection({
  id,
  label,
  open,
  onToggle,
  actions,
  children,
}: {
  id: string;
  label: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sidebar-section">
      <div className="sidebar-section__header">
        {/* The toggle stretches across the header, so pressing the title (or any
            empty space beside it) collapses the section; only the action slot
            stays outside the button, because a button cannot hold a button. */}
        <h2 className="section-label sidebar-section__title">
          <button type="button" className="sidebar-section__toggle" aria-expanded={open} aria-controls={id} onClick={() => onToggle(!open)}>
            <span>{label}</span>
            <Icon name="chevron-right" size={14} className={`sidebar-section__chevron${open ? ' is-open' : ''}`} />
          </button>
        </h2>
        {actions ? <div className="sidebar-section__actions">{actions}</div> : null}
      </div>
      <Collapsible id={id} open={open}>
        {children}
      </Collapsible>
    </section>
  );
}
