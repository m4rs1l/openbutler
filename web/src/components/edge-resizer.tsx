import type { KeyboardEvent, ReactNode } from 'react';
import type { useEdgeResize } from '../edge-resize.js';

export interface EdgeResizerProps {
  edge: ReturnType<typeof useEdgeResize>;
  className: string;
  label: string;
  controls: string;
  min: number;
  max: number;
  value: number;
  title?: string;
  hidden?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children?: ReactNode;
}

/**
 * Standard edge resize separator handle with pointer capture and ARIA slider semantics.
 * Reused by both the left sidebar and the right workspace panel.
 */
export function EdgeResizer({
  edge,
  className,
  label,
  controls,
  min,
  max,
  value,
  title,
  hidden = false,
  onKeyDown,
  children,
}: EdgeResizerProps) {
  return (
    <div
      role="separator"
      tabIndex={0}
      hidden={hidden}
      className={className}
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} pixels`}
      title={title}
      onPointerDown={edge.start}
      onPointerMove={edge.move}
      onPointerUp={edge.finish}
      onPointerCancel={edge.finish}
      onLostPointerCapture={edge.finish}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
