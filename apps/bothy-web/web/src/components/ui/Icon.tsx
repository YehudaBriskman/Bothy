// Icon - five sizes and a stroke that does not thicken as the glyph grows
// (design audit SYS-15, 2026-09-21; every call site moved here in batch 4).
//
// lucide was called with 14 different `size=` values across 253 call sites, and
// the close X alone came in 12, 13, 14 and 16. lucide scales its 2px stroke
// with the glyph, so a 20px icon drew a heavier line than a 12px one beside it.
// `absoluteStrokeWidth` keeps the line at the same width at every size.
//
// That width is 1.25px. Batch 2 wrote 1.75 before anything used it; measured
// against what the app actually drew - lucide's 2 at 24 is 1.17px at the
// common 14px and 1.33px at 16 - 1.75 would have thickened every glyph by
// about 40%. 1.25 is the line the app already had, now at every size.
//
// ICON mirrors --icon-xs..-xl in index.css; checks/design-tokens.mjs asserts
// the two agree AND that no lucide glyph is rendered anywhere but here. The
// sweep's snap: 9-12 -> xs, 13-14 -> sm, 15-17 -> md, 18-21 -> lg, 22+ -> xl.
// xl (24) is for the one-glyph illustrations: an empty state, a header tile.

import type { LucideIcon, LucideProps } from 'lucide-react';

export const ICON = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 } as const;
export type IconSize = keyof typeof ICON;

export interface IconProps extends Omit<LucideProps, 'size' | 'ref'> {
  icon: LucideIcon;
  size?: IconSize;
}

export function Icon({ icon: Glyph, size = 'md', strokeWidth = 1.25, ...rest }: IconProps) {
  return <Glyph size={ICON[size]} strokeWidth={strokeWidth} absoluteStrokeWidth aria-hidden={rest['aria-label'] ? undefined : true} {...rest} />;
}
