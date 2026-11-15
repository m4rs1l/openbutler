import { useEffect, useRef, useState } from 'react';
import { Icon } from './icon.js';
import './message-actions.css';

export type CopyStatus = 'idle' | 'copied' | 'failed';

/** How long the confirmation stays up before the row returns to rest. */
export const COPY_FEEDBACK_MS = 1_800;

export function copyLabel(status: CopyStatus): string {
  return status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy';
}

export function copyIcon(status: CopyStatus): 'copy' | 'check' {
  return status === 'copied' ? 'check' : 'copy';
}

/**
 * Copies the stored message source, the same contract as the code-block and
 * queue copy actions: the renderer's own text, never the composed DOM.
 */
export async function copyMessageText(text: string): Promise<CopyStatus> {
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/** The copy button owns its status machine: idle → copied/failed → idle. */
function CopyButton({ text }: { text: string }) {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    setStatus(await copyMessageText(text));
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), COPY_FEEDBACK_MS);
  };
  const label = copyLabel(status);
  return (
    <button
      type="button"
      data-scroll-preserve
      onClick={() => void copy()}
      aria-label={label}
      title={label}
      className={status === 'copied' ? 'copied' : undefined}
    >
      <Icon name={copyIcon(status)} size={14} />
      <span className="sr-only" aria-live="polite">
        {label}
      </span>
    </button>
  );
}

/**
 * The row's extension point: a new button registers here as its own component
 * and joins a caller's list. The row, the bubbles and turn.tsx stay untouched.
 */
export const MESSAGE_ACTIONS = {
  copy: CopyButton,
} as const;

export type MessageActionId = keyof typeof MESSAGE_ACTIONS;

/**
 * The action row under a message bubble. Buttons are 20px and chrome-free at
 * rest; an empty message renders no row at all.
 */
export function MessageActions({ text, actions = ['copy'] }: { text: string; actions?: readonly MessageActionId[] }) {
  if (!text.trim()) return null;
  return (
    <div className="message-actions">
      {actions.map((id) => {
        const Button = MESSAGE_ACTIONS[id];
        return <Button key={id} text={text} />;
      })}
    </div>
  );
}
