import type { ComponentProps, CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';
import { resolveGlyph, type IconName } from '../icons/registry.js';

export type { IconName };
export type IconProps = Omit<ComponentProps<LucideIcon>, 'ref'> & { name: IconName };

/**
 * Renders a registered glyph. The name is the whole contract: it is checked
 * against the registry at compile time, and at runtime an unregistered one
 * draws the reserved blank box instead of reaching the network.
 *
 * The two families are drawn differently and that difference lives here, not
 * in the callers: a line glyph is stroked with `size`/`strokeWidth`, a brand
 * mark is placed in the box at `size` and keeps its own fill.
 */
export function Icon({ name, size = 18, strokeWidth = 1.6, className = '', style, ...props }: IconProps) {
  const iconClass = `icon ${className}`.trim();
  const iconStyle = { '--icon-size': typeof size === 'number' ? `${size}px` : size, ...style } as CSSProperties;
  const labelled = Boolean(props['aria-label'] || props['aria-labelledby']);
  const glyph = resolveGlyph(name);
  if (!glyph) return <span className={iconClass} style={iconStyle} aria-hidden="true" />;
  if (glyph.kind === 'brand') {
    return (
      <glyph.component
        {...props}
        width={size}
        height={size}
        aria-hidden={labelled ? undefined : true}
        focusable={false}
        className={iconClass}
        style={iconStyle}
      />
    );
  }
  return (
    <glyph.component
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden={labelled ? undefined : true}
      focusable={false}
      {...props}
      className={iconClass}
      style={iconStyle}
    />
  );
}
