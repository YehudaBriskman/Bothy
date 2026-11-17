import leakPatterns from '../../leak-patterns.json' with { type: 'json' };

/**
 * What may be published. Two independent guards, because either alone has a
 * failure mode the other covers:
 *
 *   1. PATHS. Only files named in docs-allowlist.json are rendered, and even a
 *      listed file is refused if its path reaches a private area. An allowlist
 *      alone would let a careless edit add `kb/...`; a denylist alone would
 *      miss the next private folder nobody thought to name.
 *   2. CONTENT. Everything rendered, and later everything built, is scanned for
 *      the shapes of a tailnet address or a credential (leak-patterns.json).
 *      A path check cannot see an address pasted into an innocent page.
 */

/** Directory names that are never public, anywhere in a path. */
const PRIVATE_SEGMENT = /(^|\/)(kb|claude-notes|\.claude|\.git|secrets?|credentials?)(\/|$)/i;
/** File shapes that are never public. */
const PRIVATE_FILE = /(^|\/)(\.env[^/]*|[^/]*\.(key|pem|age)|[^/]*credentials[^/]*)$/i;

export class UnsafePathError extends Error {}

/** Normalise a path relative to the docs/ directory, or throw. */
export function assertPublicDocPath(file: string): string {
  if (typeof file !== 'string' || !file) throw new UnsafePathError('empty path');
  if (file.includes('\0') || file.includes('\\')) throw new UnsafePathError(`${file}: not a plain relative path`);
  if (file.startsWith('/') || /^[a-z]+:/i.test(file)) throw new UnsafePathError(`${file}: must be relative to docs/`);
  const parts: string[] = [];
  for (const seg of file.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new UnsafePathError(`${file}: climbs out of docs/`);
    parts.push(seg);
  }
  const clean = parts.join('/');
  if (!clean.endsWith('.md')) throw new UnsafePathError(`${file}: only Markdown is rendered`);
  if (PRIVATE_SEGMENT.test(clean) || PRIVATE_FILE.test(clean)) {
    throw new UnsafePathError(`${file}: this path is private and is never published`);
  }
  return clean;
}

/** Whether a repository-relative path may be LINKED to (as opposed to rendered). */
export function isPublicRepoPath(repoPath: string): boolean {
  const p = repoPath.replace(/^\/+/, '');
  if (p.startsWith('docs/kb') || p.startsWith('claude-notes')) return false;
  return !(PRIVATE_SEGMENT.test(p) || PRIVATE_FILE.test(p));
}

export interface Leak {
  name: string;
  match: string;
}

const compiled = leakPatterns.patterns.map((p) => ({ name: p.name, re: new RegExp(p.source, `${p.flags}g`) }));

/** Every leak-shaped string in `text`. The match is returned so a human can find it. */
export function findLeaks(text: string): Leak[] {
  const found: Leak[] = [];
  for (const { name, re } of compiled) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) found.push({ name, match: m[0].length > 60 ? `${m[0].slice(0, 57)}…` : m[0] });
  }
  return found;
}
