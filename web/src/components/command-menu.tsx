import type { CommandSpec } from '../../../src/commands/registry.js';
import { Icon, type IconName } from './icon.js';
import './command-menu.css';

/** The glyph beside each command, chosen from the static icon registry. */
const COMMAND_ICONS: Record<string, IconName> = {
  '/help': 'command',
  '/new': 'eraser',
  '/settings': 'sliders-horizontal',
  '/permissions': 'key-round',
  '/reasoning': 'contrast',
  '/compact': 'list-collapse',
  '/stop': 'circle-stop',
  '/models': 'box',
  '/provider': 'waypoints',
  '/session': 'history',
};

interface CommandMenuProps {
  items: CommandSpec[];
  activeIndex: number;
  onSelect: (spec: CommandSpec) => void;
  onHover: (index: number) => void;
}

/**
 * The panel that opens above the composer while a bare `/` token is typed. It
 * never takes focus: the textarea keeps it, so the arrows and Enter that arrive
 * there drive this list, and a press on a row must not blur the box underneath.
 */
export function CommandMenu({ items, activeIndex, onSelect, onHover }: CommandMenuProps) {
  return (
    <div className="command-menu" role="listbox" aria-label="Commands">
      {items.map((spec, index) => (
        <div
          key={spec.name}
          id={`command-${spec.name.slice(1)}`}
          role="option"
          aria-selected={index === activeIndex}
          className={`command-menu-item${index === activeIndex ? ' active' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onSelect(spec)}
        >
          <Icon name={COMMAND_ICONS[spec.name] ?? 'square-terminal'} size={16} />
          <span className="command-menu-name">{spec.name}</span>
          <span className="command-menu-description">{spec.description}</span>
        </div>
      ))}
    </div>
  );
}
