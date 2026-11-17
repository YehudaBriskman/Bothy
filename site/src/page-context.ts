import type { DocPage } from './docs/docs.ts';
import type { Messages } from './i18n/en.ts';
import type { Locale } from './i18n/locales.ts';
import type { Release, ReleaseFeed } from './lib/releases.ts';

/** Everything a page component may read. Built once per page by the prerender. */
export interface PageContext {
  locale: Locale;
  t: Messages;
  feed: ReleaseFeed;
  latest: Release;
  docs: DocPage[];
  /** The page's path with the locale prefix removed, e.g. `/install/`. Used to link the same page in another locale. */
  pathWithoutLocale: string;
}
