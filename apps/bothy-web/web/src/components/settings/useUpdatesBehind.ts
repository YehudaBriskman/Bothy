// How many components are a minor version or more behind, for the count on the
// Settings nav. Shared by the Settings sidebar and the person menu through
// lib/updates.ts, which fetches at most once a quarter hour per tab: every read of
// /-/api/updates/status is an audit line, so a badge must not cost one per render.
//
// null means "unknown" - not signed in, no viewer role, not deployed, or the read
// failed - and draws nothing. A badge that guessed would be worse than none.

import { useEffect, useState } from 'react';
import { behindNow, loadBehind, onBehind } from '../../lib/updates';

export function useUpdatesBehind(enabled = true): number | null {
  const [n, setN] = useState<number | null>(behindNow);
  useEffect(() => {
    const off = onBehind(setN);
    if (enabled) void loadBehind().then(setN);
    return off;
  }, [enabled]);
  return n;
}
