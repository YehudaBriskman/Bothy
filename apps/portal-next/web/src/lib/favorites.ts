// Favorites — pin the systems (and links) you use most so they float to the top
// of the Overview. Persisted in localStorage; keys are arbitrary strings (a
// system key like 'tals', or a link id). Cross-tab safe via the 'storage' event.

import { useCallback, useEffect, useState } from 'react';

const KEY = 'portal-favs';

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function useFavorites() {
  const [favs, setFavs] = useState<Set<string>>(read);

  // Reflect changes made in other tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setFavs(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const persist = useCallback((next: Set<string>) => {
    setFavs(next);
    try {
      localStorage.setItem(KEY, JSON.stringify([...next]));
    } catch {
      /* private mode / quota — favorites just won't persist */
    }
  }, []);

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(favs);
      next.has(id) ? next.delete(id) : next.add(id);
      persist(next);
    },
    [favs, persist],
  );

  const isFav = useCallback((id: string) => favs.has(id), [favs]);

  return { favs, isFav, toggle };
}

// Stable sort helper: favorited items first, order otherwise preserved.
export function favFirst<T>(items: T[], keyOf: (t: T) => string, favs: Set<string>): T[] {
  return items
    .map((item, i) => ({ item, i, fav: favs.has(keyOf(item)) }))
    .sort((a, b) => Number(b.fav) - Number(a.fav) || a.i - b.i)
    .map((x) => x.item);
}
