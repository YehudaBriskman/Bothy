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
import { langFor } from '../../lib/files';
import { highlight } from './highlight';

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]*\]\([^)\s]+\))/g;

function inlineMd(text: string, k: string): ReactNode[] {
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
    if (tok.startsWith('`')) out.push(<code className="md-code" key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<strong key={key}>{inlineMd(tok.slice(2, -2), `${key}s`)}</strong>);
    else if (tok.startsWith('[')) {
      const cut = tok.indexOf('](');
      const label = tok.slice(1, cut);
      const href = tok.slice(cut + 2, -1);
      // Only http(s), mailto and anchors become links. A repo-relative path is
      // not a URL this page can resolve, and `javascript:` must never become an
      // href - both render as text with the target shown beside them.
      out.push(/^(https?:\/\/|#|mailto:)/i.test(href)
        ? <a className="md-link" href={href} target="_blank" rel="noreferrer" key={key}>{label || href}</a>
        : <span className="md-reflink" key={key}>{label || href}<span className="md-reftarget">{href}</span></span>);
    } else out.push(<em key={key}>{inlineMd(tok.slice(1, -1), `${key}e`)}</em>);
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

function isBlockStart(line: string): boolean {
  return RE_FENCE.test(line) || RE_HEAD.test(line) || RE_RULE.test(line)
    || RE_QUOTE.test(line) || RE_ITEM.test(line);
}

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

export function renderMd(src: string, k = 'b'): ReactNode[] {
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
      out.push(<Tag className={`md-h md-h${lvl}`} key={key()}>{inlineMd(head[2], key())}</Tag>);
      i++;
      continue;
    }

    if (RE_RULE.test(line)) { out.push(<hr className="md-hr" key={key()} />); i++; continue; }

    if (RE_QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) buf.push(lines[i++].replace(RE_QUOTE, ''));
      out.push(<blockquote className="md-quote" key={key()}>{renderMd(buf.join('\n'), `${key()}q`)}</blockquote>);
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
              <tr>{cols.map((c, ci) => <th key={ci}>{inlineMd(c, `${tk}h${ci}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inlineMd(c, `${tk}r${ri}c${ci}`)}</td>)}</tr>
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
              {inlineMd(it.text, `${lk}t${ii}`)}
              {it.sub.some((s) => s.trim()) && renderMd(it.sub.join('\n'), `${lk}s${ii}`)}
            </li>
          ))}
        </List>,
      );
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    const pk = key();
    out.push(<p className="md-p" key={pk}>{inlineMd(buf.join(' '), pk)}</p>);
  }
  return out;
}
