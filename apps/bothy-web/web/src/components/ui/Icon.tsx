// Icon - four sizes and a stroke that does not thicken as the glyph grows
// (design audit SYS-15, 2026-09-21).
//
// lucide was called with 14 different `size=` values across 253 call sites, and
// the close X alone came in 12, 13, 14 and 16. lucide scales its 2px stroke
// with the glyph, so a 20px icon drew a heavier line than a 12px one beside it.
// `absoluteStrokeWidth` keeps the line at the same 1.75px at every size.
//
// ICON mirrors --icon-xs/-sm/-md/-lg in index.css; checks/design-tokens.mjs
// asserts the two agree. New code takes <Icon icon={X} size="md" />; the other
// call sites move across with the batch-4 sweep, file by file.

import type { LucideIcon, LucideProps } from 'lucide-react';

export const ICON = { xs: 12, sm: 14, md: 16, lg: 20 } as const;
export type IconSize = keyof typeof ICON;

export interface IconProps extends Omit<LucideProps, 'size' | 'ref'> {
  icon: LucideIcon;
  size?: IconSize;
}

export function Icon({ icon: Glyph, size = 'md', strokeWidth = 1.75, ...rest }: IconProps) {
  return <Glyph size={ICON[size]} strokeWidth={strokeWidth} absoluteStrokeWidth aria-hidden={rest['aria-label'] ? undefined : true} {...rest} />;
}
