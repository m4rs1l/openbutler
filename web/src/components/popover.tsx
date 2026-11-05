import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui.js';

export interface PopoverTriggerProps {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

export function Popover({
  label,
  trigger,
  renderTrigger,
  disabled,
  children,
  className = '',
}: {
  className?: string;
  label: string;
  /** Content for the default trigger button. */
  trigger?: ReactNode;
  /** Own trigger element instead: same contract Dropdown already exposes, so a
   *  consumer can hand in an IconButton rather than restyling the default. */
  renderTrigger?: (props: PopoverTriggerProps) => ReactNode;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const toggle = () => setOpen((value) => !value);
  const close = () => setOpen(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return (
    <div className={`popover ${className}`} ref={root}>
      {renderTrigger ? (
        renderTrigger({ open, toggle, close })
      ) : (
        <Button
          className="popover-trigger"
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="dialog"
          disabled={disabled}
          onClick={toggle}
        >
          {trigger}
        </Button>
      )}
      {open ? (
        <div className="popover-panel" role="dialog" aria-label={label}>
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}
