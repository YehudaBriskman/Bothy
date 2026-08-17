// ── markdown, rendered as React elements ─────────────────────────────────────
//
// Markdown is the most-read format on this box, so it keeps a rendered preview
// beside the source. A deliberately small subset - headings, fences, quotes,
// rules, lists, tables, and inline code/emphasis/links - built as ELEMENTS,
// never as an HTML string. That is the property that makes rendering repo
// content safe with no sanitiser: there is no innerHTML anywhere, so every
// scrap of file content is escaped by React whether or not this parser
// understood it. Anything it does not understand falls through as literal text,
// and the Source toggle is one click away, so a mis-parse is cosmetic.

import type { ReactNode } from 'react';
import {
  Info, Lightbulb, MessageSquareWarning, OctagonAlert, TriangleAlert,
} from 'lucide-react';
import { langFor } from '../../lib/files';
import { highlight } from './highlight';
import { resolveRelative } from './tree';

// ── cross-document links ─────────────────────────────────────────────────────
//
// What a repo-relative link needs in order to go somewhere, and the reason it is
// passed IN rather than reached for: this module still knows nothing about
// roots, tabs or the workspace. It is handed a directory and a callback.
//
// Absent, every relative link keeps the inert rendering below - which is what a
// caller with nowhere to send the reader should show.
export interface MdLinks {
  /** The directory of the file being rendered, root-relative, `''` at the top.
   *  Targets join against THIS and not against the page's URL, because a link
   *  in a document means what it means where the document lives. */
  dir: string;
  /** Open a root-relative path in the same root. `frag` is the `#heading` the
   *  link carried, or `''`; the caller decides whether it can honour it. */
  open: (path: string, frag: string) => void;
  /** Resolve a WIKILINK target - `[[dns]]`, `[[network/dns]]`, `[[dns#ttl]]` -
   *  to a real path, or null.
   *
   *  Supplied by the caller rather than computed here, and that is the same
   *  division this interface already draws: a wikilink has no extension and no
   *  directory, so answering it needs the LIST OF DOCUMENTS, which is exactly
   *  the knowledge this module is built not to have. Absent, wikilinks render
   *  inert like any other unresolvable link - which is the honest result for a
   *  caller that cannot say what exists. */
  resolveWiki?: (target: string) => { path: string; frag: string } | null;
}

// Only http(s), mailto and anchors become an <a href>. Everything else is a
// candidate for the relative-link treatment - which is never an href either.
const RE_WEB = /^(https?:\/\/|#|mailto:)/i;

// Anything carrying a SCHEME stays inert, and `javascript:` is the reason. It is
// not that it would be dangerous as an href here - it never becomes one - but
// that resolving it as a path would turn it into a live-looking button that
// opens a file named `javascript:alert(1)`. A scheme this page does not know is
// not a path; `//host/x` is not one either.
const RE_SCHEME = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

function refLink(
  href: string, label: string, key: string, links?: MdLinks, wiki = false,
): ReactNode {
  // Today's rendering, and still the answer for anything that does not resolve:
  // the text, with the target beside it, because the target is information the
  // reader wanted and an unresolvable link is worth SEEING as unresolvable.
  const inert = (
    <span className="md-reflink" key={key}>{label || href}<span className="md-reftarget">{href}</span></span>
  );
  if (!links || RE_SCHEME.test(href)) return inert;
  // A wikilink is resolved ONLY against the index, and never falls back to
  // resolveRelative - which is the difference between the two syntaxes rather
  // than an omission.
  //
  // resolveRelative normalises a path; it does not know what exists, because for
  // a markdown link it does not have to - the author wrote a path and the reader
  // can see whether it opens. `[[nothing-here]]` has no path in it at all, so
  // falling through turned it into a live button pointing at a file of that
  // name. Measured on a probe document: an unresolvable wikilink rendered as
  // resolved, which is the worst of the three possible answers.
  //
  // resolveWikiIn handles `[[network/dns]]` too, so nothing is lost by not
  // falling back.
  const hit = wiki
    ? (links.resolveWiki?.(href) ?? null)
    : resolveRelative(links.dir, href);
  if (!hit) return inert;
  // A BUTTON, never an anchor. The `javascript:` argument above only stays true
  // as long as nothing here writes an href, and a handler that calls the
  // open-file action is also the only thing that can address a file inside a
  // root - there is no URL for one.
  //
  // No target chip on this one: the chip existed because the reader could not
  // follow the link and the target was the only information left. A link that
  // opens carries its own answer, and the resolved path is in the tooltip.
  return (
    <button
      type="button"
      className="md-reflink md-reflink-on"
      key={key}
      title={hit.path + hit.frag}
      onClick={() => links.open(hit.path, hit.frag)}
    >
      {label || href}
    </button>
  );
}

// The wiki alternative comes FIRST and that is load-bearing: `[[dns]]` would
// otherwise be matched by the inline-link arm as `[` followed by `[dns]`, and
// the reader would print a stray bracket beside a broken link.
const INLINE_RE = /(\[\[[^\]\n]+\]\])|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]*\]\([^)\s]+\))/g;

function inlineMd(text: string, k: string, links?: MdLinks): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const tok = m[0];
    const key = `${k}i${n++}`;
    // Emphasis RECURSES; code does not. Without the recursion an italic line
    // containing a link or a `code span` swallows it whole and prints the
    // markdown source - measured on docs/kb/access.md, whose second line is
    // exactly that shape. Code is terminal by definition: it is literal.
    if (tok.startsWith('[[')) {
      // `[[target]]` or `[[target|label]]`. It resolves through refLink, the
      // SAME path a relative markdown link takes - so a wikilink inherits the
      // property that file records at length: it never becomes an <a href>, and
      // therefore `javascript:` can never reach one. A new syntax, an existing
      // resolver.
      const inner = tok.slice(2, -2);
      const bar = inner.indexOf('|');
      const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
      const label = bar === -1 ? '' : inner.slice(bar + 1).trim();
      out.push(refLink(target, label || target, key, links, true));
    } else if (tok.startsWith('`')) out.push(<code className="md-code" key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<strong key={key}>{inlineMd(tok.slice(2, -2), `${key}s`, links)}</strong>);
    else if (tok.startsWith('[')) {
      const cut = tok.indexOf('](');
      const label = tok.slice(1, cut);
      const href = tok.slice(cut + 2, -1);
      // Only http(s), mailto and anchors become an <a href>, unchanged. A
      // repo-relative path is not a URL this page can hand the browser - it
      // goes through the open-file action instead, when it resolves, and keeps
      // the old inert rendering when it does not. See refLink above.
      out.push(RE_WEB.test(href)
        ? <a className="md-link" href={href} target="_blank" rel="noreferrer" key={key}>{label || href}</a>
        : refLink(href, label, key, links));
    } else out.push(<em key={key}>{inlineMd(tok.slice(1, -1), `${key}e`, links)}</em>);
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const RE_FENCE = /^```(\S*)\s*$/;
const RE_HEAD = /^(#{1,6})\s+(.*)$/;
const RE_RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^>\s?/;
const RE_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

// ── callouts ─────────────────────────────────────────────────────────────────
//
// `> [!warning] Optional title`, the syntax Obsidian and GitHub both understand.
// Using theirs rather than inventing one matters here: ~/claude-notes is read in
// this reader AND in an editor, and a note that renders as a panel in one and as
// a literal `[!warning]` in the other is worse than plain prose in both.
//
// THE COLOURS ARE THE STATUS COLOURS, and that is a deliberate exemption from
// the standing rule that `--st-*` is reserved for service state. The rule exists
// so a green decoration is never read as "up"; in a rendered DOCUMENT there is
// no service status on the page for an amber panel to be confused with. The
// exemption is scoped to `.md-callout` and stated in read.css beside the rule.
// If a callout is ever rendered somewhere that also shows service status, it is
// void.
const RE_CALLOUT = /^\s*\[!([a-z]+)\]\s*(.*)$/i;

type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

const CALLOUTS: Record<CalloutKind, { title: string; tone: string; Icon: typeof Info }> = {
  note:      { title: 'Note',      tone: 'note', Icon: Info },
  tip:       { title: 'Tip',       tone: 'tip',  Icon: Lightbulb },
  important: { title: 'Important', tone: 'note', Icon: MessageSquareWarning },
  warning:   { title: 'Warning',   tone: 'warn', Icon: TriangleAlert },
  caution:   { title: 'Caution',   tone: 'bad',  Icon: OctagonAlert },
};

function isBlockStart(line: string): boolean {
  return RE_FENCE.test(line) || RE_HEAD.test(line) || RE_RULE.test(line)
    || RE_QUOTE.test(line) || RE_ITEM.test(line);
}

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

// ── heading anchors ──────────────────────────────────────────────────────────
//
// The `#the-evidence` half of a cross-document link. GitHub's slug rules, near
// enough: strip the inline markers, lowercase, and everything that is not
// alphanumeric becomes a hyphen.
//
// Written to a DATA ATTRIBUTE and not to `id`, which is not fussiness: the
// editor keeps every open document mounted at once, so two open files with an
// `## Overview` each would put two `id="overview"` in one document and
// `getElementById` would answer with whichever the DOM found first. A data
// attribute is only ever queried from the article that owns it.
//
// No de-duplication suffix. Two headings with the same text scroll to the first
// one, which is the honest limit of a slug with no index behind it and is what
// the reader would have found by searching anyway.
export function slugOf(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function renderMd(src: string, k = 'b', links?: MdLinks): ReactNode[] {
  const lines = src.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `${k}${n++}`;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = RE_FENCE.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i])) buf.push(lines[i++]);
      i++;
      const body = buf.join('\n');
      // A fenced block gets the same highlighter as the Source view, so a yaml
      // snippet inside a doc is coloured the way the yaml file itself is.
      const lang = fence[1] ? langFor(`x.${fence[1]}`, undefined) : '';
      out.push(
        <pre className="md-pre scroll-shade" key={key()} tabIndex={0}>
          {fence[1] && <span className="md-lang">{fence[1]}</span>}
          <code>{lang ? highlight(body, lang) : body}</code>
        </pre>,
      );
      continue;
    }

    const head = RE_HEAD.exec(line);
    if (head) {
      const lvl = head[1].length;
      // Levels shift down one: the shell already owns the document title, so a
      // file's own `#` must not compete with it in the outline.
      const Tag = `h${Math.min(lvl + 1, 6)}` as 'h2';
      out.push(
        <Tag className={`md-h md-h${lvl}`} key={key()} data-md-anchor={slugOf(head[2])}>
          {inlineMd(head[2], key(), links)}
        </Tag>,
      );
      i++;
      continue;
    }

    if (RE_RULE.test(line)) { out.push(<hr className="md-hr" key={key()} />); i++; continue; }

    if (RE_QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) buf.push(lines[i++].replace(RE_QUOTE, ''));

      // A CALLOUT is a blockquote whose first line names a kind. Obsidian's
      // syntax and GitHub's are the same here, which is the reason to use it
      // rather than invent one: the notes in ~/claude-notes are read in both.
      //
      // Parsed as a branch of the quote rather than as its own block type,
      // because that is exactly what it is - everything below the marker line
      // is quote content and renders through the same path.
      const marker = RE_CALLOUT.exec(buf[0] ?? '');
      if (marker) {
        const kind = marker[1].toLowerCase() as CalloutKind;
        const meta = CALLOUTS[kind] ?? CALLOUTS.note;
        const title = marker[2]?.trim() || meta.title;
        const body = buf.slice(1).join('\n');
        out.push(
          <div className={`md-callout is-${meta.tone}`} key={key()} role="note">
            <p className="md-callout-h">
              <meta.Icon size={15} aria-hidden="true" />
              <span>{title}</span>
            </p>
            {body.trim() && (
              <div className="md-callout-b">{renderMd(body, `${key()}c`, links)}</div>
            )}
          </div>,
        );
        continue;
      }

      out.push(<blockquote className="md-quote" key={key()}>{renderMd(buf.join('\n'), `${key()}q`, links)}</blockquote>);
      continue;
    }

    // GFM table: a header row followed by a |---|---| separator.
    if (line.includes('|') && i + 1 < lines.length
        && /^[\s:|-]+$/.test(lines[i + 1]) && lines[i + 1].includes('-') && lines[i + 1].includes('|')) {
      const cols = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const tk = key();
      out.push(
        <div className="md-tbl-wrap scroll-shade" key={tk} tabIndex={0}>
          <table className="md-tbl">
            <thead>
              <tr>{cols.map((c, ci) => <th key={ci}>{inlineMd(c, `${tk}h${ci}`, links)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inlineMd(c, `${tk}r${ri}c${ci}`, links)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const item = RE_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const base = item[1].length;
      const items: { text: string; sub: string[] }[] = [];
      while (i < lines.length) {
        const m = RE_ITEM.exec(lines[i]);
        if (m && m[1].length <= base) { items.push({ text: m[3], sub: [] }); i++; continue; }
        // A deeper-indented or continuation line belongs to the item above it.
        if (lines[i].trim() && lines[i].search(/\S/) > base && items.length) {
          items[items.length - 1].sub.push(lines[i].slice(base + 2));
          i++;
          continue;
        }
        // A blank line only ends the list if what follows is not another item.
        if (!lines[i].trim() && i + 1 < lines.length
            && (RE_ITEM.test(lines[i + 1]) || lines[i + 1].search(/\S/) > base)) { i++; continue; }
        break;
      }
      const lk = key();
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List className="md-list" key={lk}>
          {items.map((it, ii) => (
            <li key={ii}>
              {inlineMd(it.text, `${lk}t${ii}`, links)}
              {it.sub.some((s) => s.trim()) && renderMd(it.sub.join('\n'), `${lk}s${ii}`, links)}
            </li>
          ))}
        </List>,
      );
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    const pk = key();
    out.push(<p className="md-p" key={pk}>{inlineMd(buf.join(' '), pk, links)}</p>);
  }
  return out;
}
