// Cheap one-shot WebGL capability check. If this returns false we render the
// static CSS layered diagram instead — the Overview must never be blank.
export function hasWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

import type { Status } from '../../lib/discover';

// The reserved status palette, mirrored EXACTLY from index.css
// (--ok/--warn/--down/--unk) so the 3D LEDs glow in the same colours as every
// dot on the page. Kept as a hard fallback; `statusHexes()` prefers the live
// computed values so a theme/token change stays in sync automatically.
export const STATUS_HEX: Record<Status, string> = {
  up: '#34d399',
  starting: '#fbbf24',
  down: '#fb7185',
  unknown: '#6b7688',
};

export const STATUS_LABEL: Record<Status, string> = {
  up: 'Up',
  starting: 'Starting',
  down: 'Down',
  unknown: 'Unknown',
};

// index.css maps state → status var (up=ok, starting=warn, down=down, unknown=unk).
const STATUS_VAR: Record<Status, string> = {
  up: '--ok', starting: '--warn', down: '--down', unknown: '--unk',
};

// Read a CSS custom property off :root, trimmed. Returns '' if unavailable.
export function cssVar(name: string): string {
  if (typeof window === 'undefined' || !window.getComputedStyle) return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Live status palette pulled from the actual CSS tokens (falls back to the
// mirrored hexes above). Read once at scene mount so the LEDs are guaranteed to
// match the page even if the tokens are edited later.
export function statusHexes(): Record<Status, string> {
  return {
    up: cssVar(STATUS_VAR.up) || STATUS_HEX.up,
    starting: cssVar(STATUS_VAR.starting) || STATUS_HEX.starting,
    down: cssVar(STATUS_VAR.down) || STATUS_HEX.down,
    unknown: cssVar(STATUS_VAR.unknown) || STATUS_HEX.unknown,
  };
}
