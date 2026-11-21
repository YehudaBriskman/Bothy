/**
 * The ONE place that knows where this site lives.
 *
 * The same build is meant to be served from two homes: the public domain, and
 * later a static module on a box. So nothing else in `src/` may contain an
 * absolute URL of the site, and nothing may assume it sits at `/`:
 *
 *   SITE_ORIGIN  the public origin, used only for canonical links, the sitemap
 *                and social cards. Set it to the empty string for a build that
 *                will be served from somewhere else (a box): the build then
 *                emits no canonical link and no sitemap, because there is no
 *                address to put in them.
 *   SITE_BASE    the path the site is mounted at: `/` (default), or `/bothy/`.
 *
 * Both are read when the prerender runs, so a deployed build is configured by
 * the environment of the build and by nothing in the source.
 */

const env = typeof process !== 'undefined' ? process.env : ({} as Record<string, string | undefined>);

function normaliseBase(raw: string): string {
  let base = raw.trim() || '/';
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
}

/** `https://bothybox.com` by default; `''` disables everything that needs an absolute address. */
export const ORIGIN: string = (env.SITE_ORIGIN ?? 'https://bothybox.com').replace(/\/+$/, '');

/** Always starts and ends with a slash. */
export const BASE: string = normaliseBase(env.SITE_BASE ?? '/');

/** The source repository. Documentation links that leave the site go here. */
export const REPO_URL = 'https://github.com/YehudaBriskman/Bothy';
export const REPO_BRANCH = 'main';
/** The maintainer's X account, the second way to reach us: it needs no GitHub account (listed on the GitHub profile). */
export const X_URL = 'https://x.com/yehudabriskman';
export const X_HANDLE = '@yehudabriskman';
export const RELEASES_URL = `${REPO_URL}/releases`;

export const SITE_NAME = 'Bothy';

/** A site-relative path (`/install/`) as an href under the configured base. */
export function href(path: string): string {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${BASE}${clean}`;
}

/** The absolute address of a site path, or null when this build has no public origin. */
export function absolute(path: string): string | null {
  return ORIGIN ? `${ORIGIN}${href(path)}` : null;
}
