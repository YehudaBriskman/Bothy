import { Lexer, Marked, type Tokens } from 'marked';
import { REPO_BRANCH, REPO_URL, href as siteHref } from '../config.ts';
import { isPublicRepoPath } from './safety.ts';

/**
 * Markdown -> HTML for the documentation section.
 *
 * The repository's Markdown is the single source, so this renderer's whole job
 * is to make it read well on the web WITHOUT editing it:
 *
 *   - relative links between listed pages become site links;
 *   - relative links to anything else in the repo go to the file on GitHub;
 *   - links into private areas (docs/kb, claude-notes) become plain text, never
 *     a link, so the published pages do not advertise them;
 *   - a link to nothing is a BUILD ERROR (the docs-link check, run again here,
 *     because a page that was fine in the repo can break when its neighbour is
 *     left off the allowlist);
 *   - GitHub's `> [!note]` callouts become callouts;
 *   - raw HTML in the source is escaped, never passed through.
 */

export interface TocEntry {
  id: string;
  text: string;
  depth: 2 | 3;
}

export interface SearchSection {
  id: string;
  heading: string;
  text: string;
}

export interface RenderedDoc {
  title: string;
  summary: string;
  html: string;
  toc: TocEntry[];
  sections: SearchSection[];
  /** Ids that exist in this document, for cross-page anchor checks. */
  ids: Set<string>;
  /** Links to other listed pages that carry a fragment: checked once every page is known. */
  anchorRefs: { slug: string; hash: string }[];
}

export interface LinkContext {
  /** Repository-relative path of the file being rendered, e.g. `docs/guide/installing.md`. */
  file: string;
  /** repo-relative path (`docs/guide/x.md`) -> slug, for every listed page. */
  pages: ReadonlyMap<string, string>;
  /** Does a repo-relative path exist? Injected so tests need no filesystem. */
  exists: (repoPath: string) => boolean;
  tableLabel: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ENTITIES[e] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** GitHub's heading slug, so an in-page `#anchor` written for GitHub keeps working. */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  );
}

/** Plain text of a Markdown fragment, for summaries and the search index. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, ' '))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a: string, b?: string) => b ?? a)
    .replace(/^>\s?(\[!\w+\])?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[`*_|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

type Resolved =
  | { kind: 'external'; href: string }
  | { kind: 'anchor'; href: string }
  | { kind: 'page'; href: string; slug: string; hash: string }
  | { kind: 'repo'; href: string }
  | { kind: 'private' }
  | { kind: 'broken'; reason: string };

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Resolve `target` against the directory of `fromFile`, collapsing `..`. Null if it leaves the repository. */
export function resolveRepoPath(fromFile: string, target: string): string | null {
  const out = dirname(fromFile).split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

export function resolveLink(raw: string, ctx: LinkContext): Resolved {
  if (/^(https?:|mailto:)/i.test(raw)) return { kind: 'external', href: raw };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { kind: 'broken', reason: `unsupported scheme in ${raw}` };
  if (raw.startsWith('#')) return { kind: 'anchor', href: raw };
  const hashAt = raw.indexOf('#');
  const pathPart = hashAt < 0 ? raw : raw.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : raw.slice(hashAt + 1);
  const repoPath = resolveRepoPath(ctx.file, decodeURI(pathPart));
  if (repoPath === null) return { kind: 'broken', reason: `${raw} leaves the repository` };
  const slug = ctx.pages.get(repoPath);
  if (slug) return { kind: 'page', href: siteHref(`/docs/${slug}/`) + (hash ? `#${hash}` : ''), slug, hash };
  if (!isPublicRepoPath(repoPath)) return { kind: 'private' };
  if (!ctx.exists(repoPath)) return { kind: 'broken', reason: `${raw} -> ${repoPath} does not exist` };
  const isDir = !/\.[A-Za-z0-9]+$/.test(repoPath);
  return {
    kind: 'repo',
    href: `${REPO_URL}/${isDir ? 'tree' : 'blob'}/${REPO_BRANCH}/${repoPath}${hash ? `#${hash}` : ''}`,
  };
}

export function renderMarkdown(source: string, ctx: LinkContext): RenderedDoc {
  const toc: TocEntry[] = [];
  const ids = new Set<string>();
  const anchorRefs: { slug: string; hash: string }[] = [];
  const problems: string[] = [];
  let title = '';

  const md = new Marked({ gfm: true, breaks: false });
  md.use({
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const text = textOf(inner);
        let id = slugify(text);
        for (let n = 2; ids.has(id); n++) id = `${slugify(text)}-${n}`;
        ids.add(id);
        if (depth === 1) {
          if (!title) title = text;
          return `<h1 id="${id}">${inner}</h1>\n`;
        }
        if (depth === 2 || depth === 3) toc.push({ id, text, depth });
        return `<h${depth} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="${escapeHtml(text)}">#</a></h${depth}>\n`;
      },
      code({ text, lang }) {
        const cls = lang ? ` class="language-${escapeHtml(lang.split(/\s/)[0] ?? '')}"` : '';
        return `<div class="code"><pre translate="no" dir="ltr" tabindex="0"><code${cls}>${escapeHtml(text)}</code></pre></div>\n`;
      },
      codespan({ text }) {
        return `<code translate="no" dir="ltr">${escapeHtml(text)}</code>`;
      },
      link({ href, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const r = resolveLink(href, ctx);
        switch (r.kind) {
          case 'external':
            return `<a href="${escapeHtml(r.href)}" rel="noopener" class="ext">${inner}</a>`;
          case 'anchor':
          case 'repo':
            return `<a href="${escapeHtml(r.href)}"${r.kind === 'repo' ? ' rel="noopener" class="ext"' : ''}>${inner}</a>`;
          case 'page':
            if (r.hash) anchorRefs.push({ slug: r.slug, hash: r.hash });
            return `<a href="${escapeHtml(r.href)}">${inner}</a>`;
          case 'private':
            return `<span class="unlinked">${inner}</span>`;
          case 'broken':
            problems.push(r.reason);
            return inner;
        }
      },
      image({ href, text }) {
        problems.push(`image ${href}: the docs are rendered without images; add an asset pipeline before using one`);
        return escapeHtml(text);
      },
      blockquote({ text, tokens }) {
        const m = /^\[!(\w+)\][ \t]*([^\n]*)\n?([\s\S]*)$/.exec(text);
        if (!m) return `<blockquote>${this.parser.parse(tokens)}</blockquote>\n`;
        const kind = (m[1] ?? 'note').toLowerCase();
        const heading = (m[2] ?? '').trim();
        const body = this.parser.parse(Lexer.lex((m[3] ?? '').trim()));
        const label = heading || kind;
        return `<aside class="callout callout-${escapeHtml(kind)}"><p class="callout-title">${escapeHtml(label)}</p>${body}</aside>\n`;
      },
    },
  });

  let html = md.parse(source, { async: false });
  html = html
    .replaceAll(
      '<table>',
      `<div class="table-wrap" role="region" aria-label="${escapeHtml(ctx.tableLabel)}" tabindex="0"><table>`,
    )
    .replaceAll('</table>', '</table></div>');

  if (problems.length) {
    throw new Error(`${ctx.file}: ${[...new Set(problems)].join('; ')}`);
  }

  // Summary and search sections come from the token stream, so they describe the
  // same words the page shows.
  const tokens = Lexer.lex(source);
  let summary = '';
  const sections: SearchSection[] = [];
  let current: SearchSection | null = null;
  const runningIds = new Set<string>();
  for (const t of tokens) {
    if (t.type === 'heading') {
      const h = t as Tokens.Heading;
      if (h.depth === 1) continue;
      let id = slugify(stripMarkdown(h.text));
      for (let n = 2; runningIds.has(id); n++) id = `${slugify(stripMarkdown(h.text))}-${n}`;
      runningIds.add(id);
      current = { id, heading: stripMarkdown(h.text), text: '' };
      sections.push(current);
    } else if (t.type === 'paragraph' || t.type === 'list' || t.type === 'table' || t.type === 'blockquote') {
      const text = stripMarkdown(t.raw);
      if (!summary && t.type === 'paragraph') summary = text.length > 200 ? `${text.slice(0, 197).trimEnd()}…` : text;
      if (!current) {
        current = { id: '', heading: '', text: '' };
        sections.push(current);
      }
      current.text += `${current.text ? ' ' : ''}${text}`;
    }
  }
  for (const s of sections) if (s.text.length > 1200) s.text = `${s.text.slice(0, 1200)}`;

  if (!title) throw new Error(`${ctx.file}: no H1 heading, so the page has no title`);
  return { title, summary, html, toc, sections, ids, anchorRefs };
}
