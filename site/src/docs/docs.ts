import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import allowlist from '../../docs-allowlist.json' with { type: 'json' };
import { renderMarkdown, type RenderedDoc } from './markdown.ts';
import { assertPublicDocPath, findLeaks } from './safety.ts';

/**
 * Loads the allowlisted repository documents and renders them.
 *
 * Build time only (it reads the filesystem). The repository root defaults to the
 * parent of `site/`; SITE_REPO_ROOT overrides it for tests and odd checkouts.
 */

export type DocGroup = 'start' | 'use' | 'operate';

export interface DocPage extends RenderedDoc {
  slug: string;
  group: DocGroup;
  /** Repository-relative path, e.g. `docs/guide/installing.md`. */
  source: string;
}

const GROUPS: readonly DocGroup[] = ['start', 'use', 'operate'];

export function repoRoot(): string {
  return resolve(process.env.SITE_REPO_ROOT ?? resolve(process.cwd(), '..'));
}

export interface AllowEntry {
  file: string;
  slug: string;
  group: string;
}

/** Validates the allowlist itself: safe paths, unique slugs, known groups. Throws on the first fault. */
export function validateAllowlist(entries: readonly AllowEntry[]): { entry: AllowEntry; clean: string }[] {
  const slugs = new Set<string>();
  const files = new Set<string>();
  return entries.map((entry) => {
    const clean = assertPublicDocPath(entry.file);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.slug))
      throw new Error(`${entry.file}: slug "${entry.slug}" is not url-safe`);
    if (slugs.has(entry.slug)) throw new Error(`docs-allowlist.json: slug "${entry.slug}" is used twice`);
    if (files.has(clean)) throw new Error(`docs-allowlist.json: ${clean} is listed twice`);
    if (!GROUPS.includes(entry.group as DocGroup)) throw new Error(`${entry.file}: unknown group "${entry.group}"`);
    slugs.add(entry.slug);
    files.add(clean);
    return { entry, clean };
  });
}

export function loadDocs(tableLabel: string, root: string = repoRoot()): DocPage[] {
  const listed = validateAllowlist(allowlist.files);
  const pages = new Map(listed.map(({ entry, clean }) => [`docs/${clean}`, entry.slug]));
  const exists = (repoPath: string) => existsSync(resolve(root, repoPath));

  const docs: DocPage[] = listed.map(({ entry, clean }) => {
    const source = `docs/${clean}`;
    const abs = resolve(root, source);
    if (!existsSync(abs)) throw new Error(`${source} is on the allowlist but does not exist`);
    const text = readFileSync(abs, 'utf8');
    const rendered = renderMarkdown(text, { file: source, pages, exists, tableLabel });
    const leaks = findLeaks(text);
    if (leaks.length) {
      throw new Error(
        `${source} holds leak-shaped text, so it cannot be published: ${leaks.map((l) => `${l.name} (${l.match})`).join('; ')}`,
      );
    }
    return { ...rendered, slug: entry.slug, group: entry.group as DocGroup, source };
  });

  // A cross-page anchor that points at a heading that is not there is a broken
  // link a reader finds by clicking it. Same check as in-repo link checking, one level deeper.
  const bySlug = new Map(docs.map((d) => [d.slug, d]));
  const bad: string[] = [];
  for (const d of docs) {
    for (const ref of d.anchorRefs) {
      if (!bySlug.get(ref.slug)?.ids.has(ref.hash)) bad.push(`${d.source} -> ${ref.slug}#${ref.hash}`);
    }
  }
  if (bad.length) throw new Error(`broken anchors between documentation pages:\n  ${bad.join('\n  ')}`);
  return docs;
}

export function groupDocs(docs: readonly DocPage[]): { group: DocGroup; pages: DocPage[] }[] {
  return GROUPS.map((group) => ({ group, pages: docs.filter((d) => d.group === group) })).filter((g) => g.pages.length);
}
