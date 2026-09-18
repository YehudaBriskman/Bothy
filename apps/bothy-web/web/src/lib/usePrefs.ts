// React half of lib/prefs.ts: one hook per preference, in sync across the page
// and across tabs.
//
// Two notification paths, because they cover different tabs: the browser's
// `storage` event fires in every OTHER tab, never the one that wrote, so a write
// here also dispatches `bothy-pref` for components in THIS tab - the Overview
// reading the section order while Settings changes it, in a split view.

import { useCallback, useEffect, useState } from 'react';
import {
  APPEARANCE_KEY, DATA_KEY, LAYOUT_KEY, parseAppearance, parseData, parseLayout,
  readRaw, stampAppearance, writeJson, type Appearance, type DataPrefs, type Layout,
} from './prefs';

const EVENT = 'bothy-pref';

function useStored<T>(key: string, parse: (raw: string | null) => T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => parse(readRaw(key)));

  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === key || e.key === null) setValue(parse(e.newValue)); };
    const onLocal = (e: Event) => { if ((e as CustomEvent<string>).detail === key) setValue(parse(readRaw(key))); };
    window.addEventListener('storage', onStorage);
    window.addEventListener(EVENT, onLocal);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(EVENT, onLocal);
    };
  }, [key, parse]);

  const set = useCallback((next: T) => {
    writeJson(key, next);
    setValue(next);
    window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
  }, [key]);

  return [value, set];
}

/** Tell every hook in this tab that a key changed or was removed outside them. */
export function announcePref(key: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
}

export function useAppearance(): [Appearance, (next: Appearance) => void] {
  const [a, set] = useStored(APPEARANCE_KEY, parseAppearance);
  useEffect(() => { stampAppearance(a, document.documentElement); }, [a]);
  return [a, set];
}

export const useLayout = (): [Layout, (next: Layout) => void] => useStored(LAYOUT_KEY, parseLayout);
export const useDataPrefs = (): [DataPrefs, (next: DataPrefs) => void] => useStored(DATA_KEY, parseData);
