import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ChevronRight, CircleCheck, Eye, FileCode2, FileText, Folder, FolderOpen,
  GitCommitVertical, History, Info, LoaderCircle, Lock, LogIn, Pencil, Save, Search, Undo2, X,
} from 'lucide-react';
import {
  fmtBytes, isAuthError, langFor, listRoots, listTree, looksBinary, readFile, relDate,
  signInUrl, writeFile,
  type Commit, type FileRead, type FileRoot, type TreeFile,
} from '../lib/files';
import { EmptyState, ErrState, Skeleton } from '../components/states';
import { Tooltip } from '../components/Tooltip';
import './Files.css';

// BothyFiles - a file explorer over the box, in the portal's own chrome.
//
// Three columns, because the page answers three questions and they are not the
// same question:
//
//   WHICH file   - the tree, left. Persistent: you pick files repeatedly.
//   WHAT it says - the viewer/editor, centre. The only column that changes mode.
//   WHO changed it - the git history, right. A permanent rail rather than a
//                    panel you have to open, because "when did this change and
//                    who did it" is the question a file explorer over a set of
//                    git repos exists to answer.
//
// EVERYTHING here needs a session. The roots now cover the stacks repo, the
// notes and ~/projects, which hold real secrets, so `viewer` is required to read
// and `editor` to save. A 401 from any call is therefore an INVITATION, not an
// error, and it is handled in exactly one shape (SignInCard) wherever it lands.

const MAX_RESULTS = 250;
// Above this the highlighter is skipped and the text is rendered plain. A regex
// scan of a megabyte is not the problem; ~40k <span> elements is.
const HIGHLIGHT_LIMIT = 200_000;

// ── the tree model ───────────────────────────────────────────────────────────
//
// A REAL tree, built once from the flat listing, rendered lazily.
//
// The old flat "group by directory" list was right for 57 files in 9 folders and
// is wrong for thousands: it renders every row in the root whether or not anyone
// looks at it, and it cannot express nesting deeper than one level.
//
// Two properties make this survive the new scale without a virtualiser:
//   · children of a COLLAPSED directory are never rendered - the DOM holds only
//     what is open, so a 5,000-entry root costs the handful of rows at its top
//     until someone opens something;
//   · the filter switches to a flat, capped result list, so the worst case is
//     MAX_RESULTS rows and not "every match in the repo".
// If a single directory ever holds thousands of siblings, THAT is the case that
// needs windowing - and it is a different fix from this one.
interface Node {
  name: string;
  path: string;
  dir: boolean;
  entry: TreeFile | null;
  children: Node[];
}

function newNode(name: string, path: string, dir: boolean): Node {
  return { name, path, dir, entry: null, children: [] };
}

function buildTree(entries: TreeFile[]): Node {
  const root = newNode('', '', true);
  const index = new Map<string, Node>([['', root]]);

  // Directories are taken from the `dir` flag when the backend sends it, and
  // INFERRED from the path separators when it does not - so the tree is correct
  // against both the old response and the new one.
  const ensureDir = (path: string): Node => {
    const found = index.get(path);
    if (found) { found.dir = true; return found; }
    const cut = path.lastIndexOf('/');
    const parent = ensureDir(cut === -1 ? '' : path.slice(0, cut));
    const node = newNode(path.slice(cut + 1), path, true);
    parent.children.push(node);
    index.set(path, node);
    return node;
  };

  for (const e of entries) {
    if (!e.path) continue;
    if (e.dir === true) { ensureDir(e.path).entry = e; continue; }
    const cut = e.path.lastIndexOf('/');
    const existing = index.get(e.path);
    if (existing) { existing.entry = e; continue; }
    const parent = ensureDir(cut === -1 ? '' : e.path.slice(0, cut));
    const node = newNode(e.path.slice(cut + 1), e.path, false);
    node.entry = e;
    parent.children.push(node);
    index.set(e.path, node);
  }

  // Directories first, then files, each alphabetically - the ordering every file
  // explorer uses, and the one that makes a deep path predictable to scan.
  // `numeric` so incident-02 sorts before incident-10.
  const sort = (n: Node) => {
    n.children.sort((a, b) =>
      a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const c of n.children) if (c.dir) sort(c);
  };
  sort(root);
  return root;
}

function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let at = path.lastIndexOf('/');
  while (at > 0) { out.push(path.slice(0, at)); at = path.lastIndexOf('/', at - 1); }
  return out;
}

// The default commit message. `docs:` is right for a note and wrong for a
// Dockerfile, and the roots now hold both - so the conventional-commit type comes
// from what the file IS. Editable either way; this only has to be a sane start.
function defaultMessage(path: string, lang: string): string {
  const prose = lang === 'md' || /\.(md|markdown|rst|txt)$/i.test(path);
  return `${prose ? 'docs' : 'chore'}: update ${path}`;
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i + 1);
}

// Truncate a folder path from the LEFT, because its tail is what distinguishes
// one of twelve compose.yml from the others - "army/CVOps/services/fronte…" is
// the one piece of the string that carries no information.
//
// Done in JS rather than in CSS on purpose. The CSS trick for a leading ellipsis
// is `direction: rtl`, which also REORDERS the text ("apps/docs/" renders as
// "/apps/docs", which looks like an absolute path and is a different claim), and
// the usual fix for that, `unicode-bidi: plaintext`, resets the resolved
// direction to LTR and puts the ellipsis back at the end - so the two
// properties cancel out. Measured in Chromium: neither alone works, and together
// they do nothing. A character count is deterministic and needs no bidi.
//
// 24, not 30: the column is ~168px wide and the mono face runs ~6.3px/char, so a
// 30-char string still overflowed and CSS added a SECOND ellipsis at the end -
// which put one at each end and threw away the tail this exists to keep.
function tailPath(p: string, max = 24): string {
  return p.length <= max ? p : `…${p.slice(p.length - max)}`;
}

// ── syntax highlighting ──────────────────────────────────────────────────────
//
// Hand-rolled, and deliberately so. package.json carries react, react-router,
// framer-motion, lucide, radix-dialog and three - no highlighter and nothing
// that could stand in for one. The candidates all cost more than this page is
// worth: shiki ships a WASM oniguruma engine plus per-language TextMate grammars
// (megabytes, or a network fetch a CSP-tight same-origin portal should not
// make), highlight.js is ~120 KB minified for its common set, and prism is
// smaller but still a plugin system and a second theme to keep in sync with the
// tokens. This is ~60 lines, adds nothing to the bundle beyond itself, and
// colours the seven languages that actually live on this box.
//
// What it is NOT: a parser. It is one alternation of regexes scanned
// left-to-right, first match wins, comments and strings ordered first so a
// keyword inside a string is not recoloured. It will be wrong on pathological
// input - a `#` inside a shell string, a regex literal containing a quote - and
// that is an acceptable price for a viewer. It cannot be wrong in a way that
// matters, because every token is emitted as a React ELEMENT: content is escaped
// by React whether or not the scanner understood it, there is no innerHTML here,
// and a mis-scan is a mis-COLOUR, never a mis-render and never an injection.
type Rules = { cls: string; re: string }[];

const STR_DQ = '"(?:\\\\[\\s\\S]|[^"\\\\])*"';
const STR_SQ = "'(?:\\\\[\\s\\S]|[^'\\\\])*'";
const NUM = '\\b(?:0[xXbo][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?)\\b';

const RULES: Record<string, Rules> = {
  ts: [
    { cls: 'com', re: '//[^\\n]*|/\\*[\\s\\S]*?\\*/' },
    { cls: 'str', re: '`(?:\\\\[\\s\\S]|[^`\\\\])*`|' + STR_DQ + '|' + STR_SQ },
    { cls: 'kw', re: '\\b(?:import|export|from|default|const|let|var|function|return|if|else|for|while|of|in|new|class|extends|implements|interface|type|enum|async|await|try|catch|finally|throw|typeof|instanceof|as|satisfies|is|void|null|undefined|true|false|this|super|switch|case|break|continue|do|delete|yield|static|public|private|protected|readonly)\\b' },
    { cls: 'num', re: NUM },
  ],
  py: [
    { cls: 'com', re: '#[^\\n]*' },
    { cls: 'str', re: '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|' + STR_DQ + '|' + STR_SQ },
    { cls: 'kw', re: '\\b(?:def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|yield|global|nonlocal|assert|del|None|True|False|self|async|await)\\b' },
    { cls: 'num', re: NUM },
  ],
  sh: [
    { cls: 'com', re: '#[^\\n]*' },
    { cls: 'str', re: STR_DQ + "|'[^']*'" },
    { cls: 'key', re: '\\$\\{[^}\\n]*\\}|\\$[A-Za-z_][A-Za-z0-9_]*' },
    { cls: 'kw', re: '\\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|export|local|readonly|source|set|unset|shift|exit|trap)\\b' },
    { cls: 'num', re: NUM },
  ],
  yml: [
    { cls: 'com', re: '#[^\\n]*' },
    { cls: 'key', re: '^[ \\t]*(?:-[ \\t]+)?[\\w.$/-]+(?=[ \\t]*:)' },
    { cls: 'str', re: STR_DQ + '|' + STR_SQ },
    { cls: 'kw', re: '\\b(?:true|false|null|yes|no|on|off)\\b' },
    { cls: 'num', re: NUM },
  ],
  json: [
    { cls: 'key', re: '"(?:\\\\[\\s\\S]|[^"\\\\])*"(?=[ \\t]*:)' },
    { cls: 'str', re: STR_DQ },
    { cls: 'kw', re: '\\b(?:true|false|null)\\b' },
    { cls: 'num', re: NUM },
  ],
  docker: [
    { cls: 'com', re: '#[^\\n]*' },
    { cls: 'kw', re: '^[ \\t]*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\\b|\\bAS\\b' },
    { cls: 'str', re: STR_DQ + '|' + STR_SQ },
    { cls: 'num', re: NUM },
  ],
  md: [
    { cls: 'str', re: '^```[\\s\\S]*?^```' },
    { cls: 'kw', re: '^#{1,6}[ \\t][^\\n]*' },
    { cls: 'com', re: '^[ \\t]*>[^\\n]*' },
    { cls: 'key', re: '\\[[^\\]\\n]*\\]\\([^)\\s]*\\)' },
    { cls: 'num', re: '`[^`\\n]+`' },
  ],
};

const SCANNERS = new Map<string, { re: RegExp; classes: string[] }>();

function scannerFor(lang: string) {
  const cached = SCANNERS.get(lang);
  if (cached) return cached;
  const rules = RULES[lang];
  if (!rules) return null;
  // One alternation, one capture group per rule - the index of the group that
  // matched IS the token class, which is why no rule may contain a capturing
  // group of its own (they are all `(?:...)`).
  const made = {
    re: new RegExp(rules.map((r) => `(${r.re})`).join('|'), 'gm'),
    classes: rules.map((r) => r.cls),
  };
  SCANNERS.set(lang, made);
  return made;
}

function highlight(src: string, lang: string): ReactNode[] {
  const scanner = src.length > HIGHLIGHT_LIMIT ? null : scannerFor(lang);
  if (!scanner) return [src];
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  scanner.re.lastIndex = 0;
  for (const m of src.matchAll(scanner.re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(src.slice(last, at));
    let g = 1;
    while (g <= scanner.classes.length && m[g] === undefined) g++;
    out.push(<span className={`hl-${scanner.classes[g - 1] ?? 'str'}`} key={n++}>{m[0]}</span>);
    last = at + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

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

function renderMd(src: string, k = 'b'): ReactNode[] {
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
      // Levels shift down one: the page already owns an <h1>, so a document's
      // own `#` must not compete with it in the outline.
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

// ── sign-in ──────────────────────────────────────────────────────────────────
//
// The ONE shape a 401 takes, wherever it lands - the tree, a file, or a save.
// Never an error state: a signed-out visitor has done nothing wrong, and this
// page's whole reason to exist is behind a door that a click opens.
function SignInCard({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <div className="state files-signin">
      <span className="files-signin-ico"><LogIn size={22} aria-hidden="true" /></span>
      <h4>Sign in to {what}</h4>
      <p>
        BothyFiles reads the stack repo, the notes and <span className="mono">~/projects</span> -
        which hold real credentials - so it asks who you are first. Browsing needs
        the <b>viewer</b> role; saving needs <b>editor</b>.
      </p>
      <div className="files-signin-actions">
        <a className="btn primary" href={signInUrl()}>Sign in</a>
        {onRetry && <button type="button" className="btn ghost" onClick={onRetry}>Retry</button>}
      </div>
    </div>
  );
}

// ── the tree rail ────────────────────────────────────────────────────────────
function TreeRows({
  nodes, depth, expanded, onToggle, current, onPick,
}: {
  nodes: Node[];
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  current: string;
  onPick: (path: string) => void;
}) {
  return (
    <ul className="ft-list">
      {nodes.map((n) => {
        // A path the service says we may not read. Shown rather than hidden -
        // "there is something here you cannot open" is information, and a file
        // that silently vanishes is the kind of gap people debug for an hour -
        // but it is a disabled row, so it can never look openable.
        const denied = n.entry?.readable === false;
        const pad = { paddingLeft: `${8 + depth * 13}px` };

        if (n.dir) {
          const open = expanded.has(n.path);
          return (
            <li key={n.path}>
              <button
                type="button"
                className="ft-row ft-dir"
                style={pad}
                aria-expanded={open}
                onClick={() => onToggle(n.path)}
                title={n.path}
              >
                <ChevronRight size={13} className={`ft-chev ${open ? 'open' : ''}`} aria-hidden="true" />
                {open
                  ? <FolderOpen size={14} className="ft-ico dir" aria-hidden="true" />
                  : <Folder size={14} className="ft-ico dir" aria-hidden="true" />}
                <span className="ft-name">{n.name}</span>
                <span className="ft-n">{n.children.length}</span>
              </button>
              {/* Lazily rendered: a closed directory puts NOTHING in the DOM,
                  which is what lets this scale past a few thousand entries. */}
              {open && n.children.length > 0 && (
                <TreeRows
                  nodes={n.children}
                  depth={depth + 1}
                  expanded={expanded}
                  onToggle={onToggle}
                  current={current}
                  onPick={onPick}
                />
              )}
            </li>
          );
        }

        const on = n.path === current;
        const writable = n.entry?.writable !== false;
        return (
          <li key={n.path}>
            <button
              type="button"
              className={`ft-row ft-file ${on ? 'on' : ''} ${denied ? 'denied' : ''}`}
              style={pad}
              aria-current={on ? 'true' : undefined}
              aria-disabled={denied || undefined}
              disabled={denied}
              onClick={() => !denied && onPick(n.path)}
              title={denied
                ? `${n.path} - this session may not read it`
                : `${n.path}${n.entry ? ` · ${fmtBytes(n.entry.size)}` : ''}${writable ? '' : ' · read-only'}`}
            >
              {denied ? <Lock size={13} className="ft-ico denied" aria-hidden="true" />
                : writable ? <FileText size={13} className="ft-ico" aria-hidden="true" />
                : <Lock size={13} className="ft-ico ro" aria-hidden="true" />}
              <span className="ft-name">{n.name}</span>
              {n.entry && !denied && <span className="ft-size">{fmtBytes(n.entry.size)}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── history rail ─────────────────────────────────────────────────────────────
function HistoryPanel({ history, loading, highlightSha }: {
  history: Commit[] | null;
  loading: boolean;
  highlightSha: string | null;
}) {
  return (
    <aside className="panel files-history" aria-label="File history">
      <div className="panel-h">
        <History size={15} aria-hidden="true" />
        <span>History</span>
        {history && <span className="sub">{history.length} commit{history.length === 1 ? '' : 's'}</span>}
      </div>
      <div className="files-history-b scroll-shade">
        {loading ? (
          <div className="files-skel" aria-hidden="true">
            {Array.from({ length: 4 }, (_, i) => <span className="skel" key={i} />)}
          </div>
        ) : !history ? (
          <p className="files-history-empty">Open a file to see how it got here.</p>
        ) : !history.length ? (
          <p className="files-history-empty">No commits touch this path - it is untracked, or outside a repo.</p>
        ) : (
          <ol className="files-commits">
            {history.map((c) => (
              <li
                className={`files-commit ${c.sha === highlightSha ? 'is-new' : ''}`}
                key={c.sha}
                title={new Date(c.date).toLocaleString()}
              >
                <GitCommitVertical size={14} className="files-commit-ico" aria-hidden="true" />
                <div className="files-commit-body">
                  <div className="files-commit-subject">{c.subject}</div>
                  <div className="files-commit-meta">
                    <span className="files-commit-sha">{c.sha.slice(0, 7)}</span>
                    <span>{c.author}</span>
                    <span className="files-commit-when">{relDate(c.date)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

// ── the page ─────────────────────────────────────────────────────────────────
type Notice =
  | { tone: 'ok'; text: string }
  | { tone: 'info'; text: string }
  | { tone: 'bad'; text: string }
  | { tone: 'auth' };

export function Files() {
  const [params, setParams] = useSearchParams();
  const root = params.get('root') || '';
  const path = params.get('path') || '';

  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [entries, setEntries] = useState<TreeFile[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeErr, setTreeErr] = useState<string | null>(null);
  // One flag for "the session is missing", set by whichever call found out.
  const [needsAuth, setNeedsAuth] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');

  const [file, setFile] = useState<FileRead | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [fileAuth, setFileAuth] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [newSha, setNewSha] = useState<string | null>(null);
  const [view, setView] = useState<'read' | 'source'>('read');
  // Set when a file or root is picked while there are unsaved edits: the switch
  // waits for an answer instead of silently throwing the work away.
  const [pending, setPending] = useState<{ root: string; path: string } | null>(null);

  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  const dirty = editing && !!file && draft !== file.content;

  // Roots. The first one is the default, so the page does not hard-code a root
  // name it may not have any more.
  useEffect(() => {
    const ac = new AbortController();
    listRoots(ac.signal)
      .then((r) => {
        setRoots(r.roots);
        setNeedsAuth(false);
        if (!r.roots.length) return;
        // No root, or a root that no longer exists (the set widened once and can
        // widen again, and people bookmark these URLs): fall back to the first
        // one rather than letting a stale link render a 400 as if the service
        // were broken. `replace`, so Back does not bounce off the dead URL.
        if (!root || !r.roots.some((x) => x.key === root)) {
          const next = new URLSearchParams();
          next.set('root', r.roots[0].key);
          setParams(next, { replace: true });
        }
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        if (isAuthError(e)) { setNeedsAuth(true); setTreeLoading(false); return; }
        setTreeErr(e instanceof Error ? e.message : String(e));
        setTreeLoading(false);
      });
    return () => ac.abort();
    // `root` is read but deliberately not a dependency: this runs once, and the
    // default-root write below is a one-shot that would otherwise re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTick]);

  useEffect(() => {
    if (!root) return;
    const ac = new AbortController();
    setTreeLoading(true);
    listTree(root, ac.signal)
      .then((r) => { setEntries(r.files); setTreeErr(null); setNeedsAuth(false); })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setEntries([]);
        if (isAuthError(e)) { setNeedsAuth(true); setTreeErr(null); return; }
        setTreeErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!ac.signal.aborted) setTreeLoading(false); });
    return () => ac.abort();
  }, [root, reloadTick]);

  // The open file. Every mode/draft/notice reset lives here, keyed on the URL,
  // so there is exactly one place that decides what "a different file" means.
  useEffect(() => {
    setEditing(false);
    setNotice(null);
    setNewSha(null);
    setView('read');
    setFileAuth(false);
    if (!root || !path) { setFile(null); setFileErr(null); return; }
    const ac = new AbortController();
    setFileLoading(true);
    readFile(root, path, ac.signal)
      .then((f) => {
        setFile(f);
        setFileErr(null);
        setDraft(f.content);
        setMessage(defaultMessage(f.path, langFor(f.path, f.lang)));
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setFile(null);
        if (isAuthError(e)) { setFileAuth(true); setFileErr(null); return; }
        setFileErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!ac.signal.aborted) setFileLoading(false); });
    return () => ac.abort();
  }, [root, path]);

  // A deep link into a nested file must arrive with its folders already open,
  // or the tree shows the reader a closed root and no sign of where they are.
  useEffect(() => {
    if (!path) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const a of ancestorsOf(path)) next.add(a);
      return next;
    });
  }, [path]);

  const tree = useMemo(() => buildTree(entries), [entries]);

  // Filtering switches the rail from a tree to a flat, ranked, capped list. At
  // this scale search IS the navigation: a name match outranks a path-only
  // match, because someone typing "compose" wants compose.yml before every file
  // that happens to live under a folder with "compose" in its name.
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return null;
    const scored: { e: TreeFile; rank: number }[] = [];
    for (const e of entries) {
      if (e.dir === true) continue;
      const lower = e.path.toLowerCase();
      const at = lower.indexOf(needle);
      if (at === -1) continue;
      const base = baseName(lower);
      scored.push({ e, rank: base.includes(needle) ? (base.startsWith(needle) ? 0 : 1) : 2 });
    }
    scored.sort((a, b) => a.rank - b.rank || a.e.path.localeCompare(b.e.path));
    return { total: scored.length, shown: scored.slice(0, MAX_RESULTS).map((s) => s.e) };
  }, [entries, q]);

  const fileCount = useMemo(() => entries.filter((e) => e.dir !== true).length, [entries]);

  const go = useCallback((nextRoot: string, nextPath: string) => {
    const next = new URLSearchParams();
    next.set('root', nextRoot);
    if (nextPath) next.set('path', nextPath);
    setParams(next);
  }, [setParams]);

  const pick = (p: string) => {
    if (dirty) { setPending({ root, path: p }); return; }
    go(root, p);
  };
  const pickRoot = (r: string) => {
    if (r === root) return;
    if (dirty) { setPending({ root: r, path: '' }); return; }
    setQ('');
    setExpanded(new Set());
    go(r, '');
  };
  const resolvePending = (discard: boolean) => {
    const p = pending;
    setPending(null);
    if (discard && p) go(p.root, p.path);
  };
  const toggleDir = (p: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });

  // `binary` is the backend's answer when it sends one; the local sniff is the
  // fallback for the response that does not carry the field yet.
  const binary = !!file && (file.binary === true || looksBinary(file.content));
  const editable = !!file && file.writable && !binary;
  const lang = file ? langFor(file.path, file.lang) : '';
  const isMarkdown = lang === 'md';

  const save = useCallback(async () => {
    if (!file || saving) return;
    setSaving(true);
    setNotice(null);
    const out = await writeFile(root, file.path, draft, message.trim() || defaultMessage(file.path, lang));
    setSaving(false);
    switch (out.kind) {
      case 'saved':
        setFile({
          ...file,
          content: draft,
          history: out.res.history,
          size: new TextEncoder().encode(draft).length,
          mtime: Date.now() / 1000,
        });
        setNewSha(out.res.sha ?? null);
        setEditing(false);
        setNotice({
          tone: 'ok',
          text: `Committed ${(out.res.sha ?? '').slice(0, 7)} - ${out.res.message || message}`,
        });
        break;
      case 'unchanged':
        // Success with nothing to do. "Failed" here would be a lie, and "saved"
        // would imply a commit that does not exist.
        setEditing(false);
        if (out.res.history?.length) setFile({ ...file, history: out.res.history });
        setNotice({ tone: 'info', text: 'No changes - nothing to commit.' });
        break;
      case 'auth':
        setNotice({ tone: 'auth' });
        break;
      case 'refused':
      case 'too-large':
      case 'error':
        setNotice({ tone: 'bad', text: out.message });
        break;
    }
  }, [file, root, draft, message, saving]);

  // Ctrl/Cmd-S while editing. The AppShell's global key handler already ignores
  // keys typed into a textarea or an input, so nothing here fights it.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, save]);

  // The browser's own guard, for the one exit this page cannot intercept.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  const startEdit = () => {
    if (!file) return;
    setDraft(file.content);
    setNotice(null);
    setEditing(true);
    requestAnimationFrame(() => editorRef.current?.focus());
  };

  const cancelEdit = () => {
    if (file) setDraft(file.content);
    setEditing(false);
    setNotice(null);
  };

  const retry = () => setReloadTick((t) => t + 1);

  return (
    <div className="page files-page">
      <div className="page-head">
        <div>
          <h1>Files</h1>
          <p className="page-sub">
            {needsAuth
              ? 'sign in to browse the box'
              : treeErr
                ? 'the file service is unreachable'
                : <><b className="tnum">{fileCount.toLocaleString()}</b> file{fileCount === 1 ? '' : 's'} in <span className="mono">{root || '…'}</span> · edits land as git commits</>}
          </p>
        </div>
      </div>

      {needsAuth ? (
        <SignInCard what="browse the box" onRetry={retry} />
      ) : treeErr && !entries.length ? (
        <ErrState
          title="Cannot reach the file service"
          body={`/-/api/files did not answer (${treeErr}). Nothing on this page can load until it does.`}
          onRetry={retry}
        />
      ) : (
        <div className="files-layout">
          <aside className="panel files-rail" aria-label="Files">
            <div className="panel-h">
              <FileCode2 size={15} aria-hidden="true" />
              <span>Explorer</span>
              <span className="sub">
                {results ? `${Math.min(results.total, MAX_RESULTS)} of ${results.total}` : fileCount.toLocaleString()}
              </span>
            </div>

            {roots.length > 1 && (
              <div className="files-roots" role="group" aria-label="Root">
                {roots.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    className={`chip ${r.key === root ? 'on' : ''}`}
                    aria-pressed={r.key === root}
                    onClick={() => pickRoot(r.key)}
                    title={r.readOnly ? `${r.label || r.key} - read-only` : (r.label || r.key)}
                  >
                    {r.key}
                    {r.readOnly && <Lock size={11} className="files-root-ro" aria-label="read-only" />}
                  </button>
                ))}
              </div>
            )}

            {/* The primary affordance at this scale, so it is above the tree and
                always visible rather than a control you have to find. */}
            <label className="files-filter">
              <Search size={14} aria-hidden="true" />
              <span className="sr-only">Filter files by path</span>
              <input
                ref={filterRef}
                type="search"
                value={q}
                placeholder="Search paths…"
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }}
              />
              {q && (
                <button type="button" className="files-filter-x" onClick={() => setQ('')} aria-label="Clear filter">
                  <X size={13} />
                </button>
              )}
            </label>

            <div className="files-tree scroll-shade">
              {treeLoading ? (
                <div className="files-skel" aria-hidden="true">
                  {Array.from({ length: 10 }, (_, i) => <span className="skel" key={i} />)}
                </div>
              ) : treeErr ? (
                <div className="files-tree-msg">
                  <p>{treeErr}</p>
                  <button type="button" className="btn ghost" onClick={retry}>Retry</button>
                </div>
              ) : results ? (
                results.shown.length === 0 ? (
                  <div className="files-tree-msg"><p>Nothing matches “{q}”.</p></div>
                ) : (
                  <>
                    <ul className="ft-list">
                      {results.shown.map((e) => (
                        <li key={e.path}>
                          <button
                            type="button"
                            className={`ft-row ft-file ft-hit ${e.path === path ? 'on' : ''} ${e.readable === false ? 'denied' : ''}`}
                            disabled={e.readable === false}
                            aria-disabled={e.readable === false || undefined}
                            onClick={() => pick(e.path)}
                            title={e.path}
                          >
                            {e.readable === false ? <Lock size={13} className="ft-ico denied" aria-hidden="true" />
                              : e.writable ? <FileText size={13} className="ft-ico" aria-hidden="true" />
                              : <Lock size={13} className="ft-ico ro" aria-hidden="true" />}
                            <span className="ft-hit-text">
                              <span className="ft-name">{baseName(e.path)}</span>
                              <span className="ft-hit-dir">{tailPath(dirName(e.path).replace(/\/$/, '') || root)}</span>
                            </span>
                            <span className="ft-size">{fmtBytes(e.size)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {results.total > MAX_RESULTS && (
                      <p className="files-tree-more">
                        {(results.total - MAX_RESULTS).toLocaleString()} more match - narrow the search.
                      </p>
                    )}
                  </>
                )
              ) : tree.children.length === 0 ? (
                <div className="files-tree-msg"><p>This root is empty.</p></div>
              ) : (
                <TreeRows
                  nodes={tree.children}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggleDir}
                  current={path}
                  onPick={pick}
                />
              )}
            </div>
          </aside>

          <section className="panel files-main" aria-label="File">
            {!path ? (
              <div className="files-main-empty">
                <EmptyState
                  message="No file open"
                  hint="Pick one on the left, or search for a path. Browsing needs the viewer role; saving needs editor."
                />
              </div>
            ) : fileAuth ? (
              <div className="files-main-empty">
                <SignInCard what="read this file" onRetry={() => go(root, path)} />
              </div>
            ) : fileLoading ? (
              <div className="files-main-empty"><Skeleton variant="table" /></div>
            ) : fileErr || !file ? (
              <div className="files-main-empty">
                <ErrState
                  title="Could not open that file"
                  body={`${root}/${path} - ${fileErr ?? 'no content came back'}`}
                  onRetry={() => go(root, path)}
                />
              </div>
            ) : (
              <>
                <header className="files-file-h">
                  <div className="files-file-id">
                    <div className="files-file-path">
                      <span className="files-file-dir">{root}/{dirName(file.path)}</span>
                      <span className="files-file-base">{baseName(file.path)}</span>
                    </div>
                    <div className="files-file-facts">
                      <span>{fmtBytes(file.size)}</span>
                      {lang && <><span aria-hidden="true">·</span><span className="files-lang">{lang}</span></>}
                      <span aria-hidden="true">·</span>
                      <span>edited {relDate(new Date(file.mtime * 1000).toISOString())}</span>
                      {!editable && !binary && (
                        <Tooltip label="The file service will not accept writes to this path - it is outside the writable set, or this session has viewer but not editor.">
                          <span className="tag"><Lock size={11} aria-hidden="true" /> read-only</span>
                        </Tooltip>
                      )}
                      {dirty && <span className="tag warn">unsaved changes</span>}
                    </div>
                  </div>

                  <div className="files-file-actions">
                    {/* The rendered/source pair is markdown's, because it is the
                        only format here that HAS a rendered form. Every other
                        file shows its source, highlighted. */}
                    {!editing && !binary && isMarkdown && (
                      <div className="seg-toggle" role="group" aria-label="View">
                        <button
                          type="button"
                          className={view === 'read' ? 'on' : ''}
                          aria-pressed={view === 'read'}
                          onClick={() => setView('read')}
                        >
                          <Eye size={14} aria-hidden="true" /> Rendered
                        </button>
                        <button
                          type="button"
                          className={view === 'source' ? 'on' : ''}
                          aria-pressed={view === 'source'}
                          onClick={() => setView('source')}
                        >
                          <FileText size={14} aria-hidden="true" /> Source
                        </button>
                      </div>
                    )}
                    {/* No Save button on a file that can only be refused. */}
                    {editable && !editing && (
                      <button type="button" className="btn" onClick={startEdit}>
                        <Pencil size={14} aria-hidden="true" /> Edit
                      </button>
                    )}
                    {editing && (
                      <>
                        <button type="button" className="btn ghost" onClick={cancelEdit} disabled={saving}>
                          <Undo2 size={14} aria-hidden="true" /> Cancel
                        </button>
                        <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
                          {saving
                            ? <LoaderCircle size={14} className="spin" aria-hidden="true" />
                            : <Save size={14} aria-hidden="true" />}
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                      </>
                    )}
                  </div>
                </header>

                {pending !== null && (
                  <div className="files-note warn" role="alert">
                    <AlertTriangle size={15} aria-hidden="true" />
                    <span>
                      <b>{baseName(file.path)}</b> has unsaved changes. Opening another file discards them.
                    </span>
                    <span className="files-note-actions">
                      <button type="button" className="btn ghost sm" onClick={() => resolvePending(false)}>
                        Keep editing
                      </button>
                      <button type="button" className="btn sm" onClick={() => resolvePending(true)}>
                        Discard and open
                      </button>
                    </span>
                  </div>
                )}

                {notice && (
                  // A live region rather than a toast: this product has no toast
                  // layer (brand/patterns/feedback.md) and an outcome you can
                  // still read beats one that has already faded.
                  <div className={`files-note ${notice.tone}`} role="status">
                    {notice.tone === 'ok' && <CircleCheck size={15} aria-hidden="true" />}
                    {notice.tone === 'info' && <Info size={15} aria-hidden="true" />}
                    {notice.tone === 'bad' && <AlertTriangle size={15} aria-hidden="true" />}
                    {notice.tone === 'auth' && <LogIn size={15} aria-hidden="true" />}
                    {notice.tone === 'auth' ? (
                      <>
                        <span>Saving needs the editor role. Your edits stay in this tab.</span>
                        <span className="files-note-actions">
                          <a className="btn sm" href={signInUrl()}>Sign in, then Save again</a>
                        </span>
                      </>
                    ) : (
                      <>
                        <span>{notice.text}</span>
                        <span className="files-note-actions">
                          <button
                            type="button"
                            className="icon-btn sm"
                            aria-label="Dismiss"
                            onClick={() => setNotice(null)}
                          >
                            <X size={14} />
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                )}

                {binary ? (
                  <div className="files-main-empty">
                    <EmptyState
                      message="Binary file"
                      hint={`${fmtBytes(file.size)} that are not text. Listed because it is in the root; not shown, because dumping the bytes would help nobody.`}
                    />
                  </div>
                ) : editing ? (
                  <div className="files-edit">
                    <label className="sr-only" htmlFor="files-editor">File contents</label>
                    <textarea
                      id="files-editor"
                      ref={editorRef}
                      className="files-textarea scroll-shade"
                      value={draft}
                      spellCheck={false}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                    <div className="files-commit-form">
                      <label className="files-commit-msg">
                        <span>Commit message</span>
                        <input
                          type="text"
                          value={message}
                          onChange={(e) => setMessage(e.target.value)}
                          placeholder={defaultMessage(file.path, lang)}
                        />
                      </label>
                      <p className="files-commit-hint">
                        {dirty
                          ? <>{draft.length.toLocaleString()} characters · <span className="kbd">Ctrl</span> <span className="kbd">S</span> saves</>
                          : 'No edits yet - saving now would commit nothing.'}
                      </p>
                    </div>
                  </div>
                ) : isMarkdown && view === 'read' ? (
                  <article className="files-read md scroll-shade" tabIndex={0}>
                    {renderMd(file.content)}
                  </article>
                ) : (
                  <pre className="files-source scroll-shade" tabIndex={0}>
                    <code>{highlight(file.content, lang)}</code>
                  </pre>
                )}
              </>
            )}
          </section>

          <HistoryPanel
            history={file ? file.history ?? [] : null}
            loading={fileLoading}
            highlightSha={newSha}
          />
        </div>
      )}
    </div>
  );
}
