// Applies the per-browser appearance preferences to the whole app, for as long
// as it runs: re-stamps <html> when Settings (or another tab) changes them, and
// tells framer-motion what CSS already knows - `reducedMotion="always"` when the
// reader turned motion off here, `"user"` (follow the OS) otherwise.
//
// The FIRST stamp happens in main.tsx before React mounts, so a compact or
// motionless browser is not drawn once the other way first.

import type { ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';
import { useAppearance } from '../../lib/usePrefs';

export function PrefsRuntime({ children }: { children: ReactNode }) {
  const [a] = useAppearance();
  return <MotionConfig reducedMotion={a.motion === 'reduce' ? 'always' : 'user'}>{children}</MotionConfig>;
}
