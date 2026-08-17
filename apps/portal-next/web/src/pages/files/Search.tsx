// ── the search rail ──────────────────────────────────────────────────────────
//
// CONTENT search across the box: every markdown file under ~/, and every other
// text file the explorer will open.
//
// IT IS NOT THE EXPLORER'S FILTER, and keeping the two apart is the whole reason
// this is a separate view rather than a mode of that box. The filter matches
// NAMES, instantly, in a tree the browser already holds. This reads file BYTES on
// the server. They answer different questions, they cost different amounts, and a
// single box that silently did both would make "no results" ambiguous - the most
// expensive kind of wrong answer a search can give.
//
// WHY IT RUNS ON A DEBOUNCE AND NOT ON EVERY KEYSTROKE. The server walk is real
// work: measured over all roots on this box, 3,433 files in 0.8-3.4 seconds. A
// request per keystroke would queue several of those behind each other and the
// answer on screen would lag the query by whole seconds. Three characters and a
// 500ms pause is the point where the request is likely to be one the user meant.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaseSensitive, FileSearch, Search as SearchIcon, X } from 'lucide-react';
import {
  isAuthError, searchFiles, type FileRoot, type SearchResult,
} from '../../lib/files';
import { Tooltip } from '../../components/Tooltip';
import { FileIcon } from './icons';
import { baseName, dirName } from './tree';

const MIN_CHARS = 3;
const DEBOUNCE_MS = 500;

/** `*` is the service's own token for "every root that does not alias another".
 *  Spelled here rather than expanded into a list of keys, because which roots
 *  those are is the service's decision (policy.toml declares it) and a list
 *  built in the browser would be a second copy of that policy. */
const ALL_ROOTS = '*';

/** One file's hits, in the order the service returned them. */
interface Group {
  root: string;
  path: string;
  lines: { line: number; col: number; srcCol: number; text: string; more?: boolean }[];
}

function groupByFile(res: SearchResult): Group[] {
  const out: Group[] = [];
  const at = new Map<string, Group>();
  for (const m of res.matches) {
    const key = `${m.root} ${m.path}`;
    let g = at.get(key);
    if (!g) {
      g = { root: m.root, path: m.path, lines: [] };
      at.set(key, g);
      out.push(g);
    }
    g.lines.push({ line: m.line, col: m.col, srcCol: m.srcCol, text: m.text, more: m.more });
  }
  return out;
}

/** Characters of the line kept BEFORE the match. The rail is ~270px of
 *  monospace - about thirty characters - so a line rendered from its start puts
 *  the match off the right edge on anything indented, which is most config and
 *  all code. Measured on this box: searching "socket-proxy" over the notes, the
 *  matched run was invisible in eleven of fourteen results.
 *
 *  The line is NOT re-trimmed to a width. It is windowed at the front and left
 *  to overflow at the back, so the surrounding text is still there for anyone
 *  who widens the rail, and there is no width the component has to guess. */
const LEAD = 8;

/** The matched run, marked. Split by OFFSET rather than by searching the line
 *  again: the server already found it, and re-finding it in the browser would
 *  disagree with the server the moment the two disagree about case folding. */
function Marked({ text, col, len }: { text: string; col: number; len: number }) {
  if (col < 0 || col > text.length) return <>{text}</>;
  const from = col > LEAD ? col - LEAD : 0;
  const head = (from ? '…' : '') + text.slice(from, col);
  return (
    <>
      {head}
      <mark className="fx-sr-mark">{text.slice(col, col + len)}</mark>
      {text.slice(col + len)}
    </>
  );
}

export function SearchView({
  roots, root, onOpen, onNeedsAuth,
}: {
  roots: FileRoot[];
  /** The root the EXPLORER is browsing. The search starts scoped to it, because
   *  that is the context the user is already in - but it is a starting value,
   *  not a binding: changing the scope here must not move the explorer. */
  root: string;
  /** `at` is the jump target: the line, and the run to select within it so the
   *  editor highlights every other occurrence in that file. */
  onOpen: (root: string, path: string, at?: { line: number; col: number; len: number }) => void;
  onNeedsAuth: () => void;
}) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<string>(root);
  const [glob, setGlob] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [res, setRes] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { boxRef.current?.focus(); }, []);

  const run = useCallback((query: string) => {
    inFlight.current?.abort();
    if (query.trim().length < MIN_CHARS) {
      setRes(null);
      setErr(null);
      setBusy(false);
      return;
    }
    const ac = new AbortController();
    inFlight.current = ac;
    setBusy(true);
    setErr(null);
    searchFiles(scope, query.trim(), { glob: glob.trim() || undefined, caseSensitive }, ac.signal)
      .then((r) => { if (!ac.signal.aborted) { setRes(r); setBusy(false); } })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setBusy(false);
        if (isAuthError(e)) { onNeedsAuth(); return; }
        setErr(e instanceof Error ? e.message : 'the search did not answer');
      });
  }, [scope, glob, caseSensitive, onNeedsAuth]);

  // `run` reaches the timer through a REF, and it is not in the dependency list.
  //
  // THIS IS NOT A LINT WORKAROUND - it is the fix for a self-sustaining search
  // loop, and the loop is worth describing because it is invisible in this file.
  // `run` is a useCallback over props, so its identity changes whenever the
  // PARENT re-renders. Files.tsx re-renders on every API call, because
  // `onApiCall` pushes each one into its call log. So: search fires -> the
  // fetch is logged -> Files.tsx re-renders -> `run` is a new function ->
  // this effect re-runs -> a fresh timer -> another search, ~every second,
  // with nobody touching the keyboard. Each one is a full server-side walk of
  // three roots.
  //
  // Depending on the VALUES rather than on the closure breaks the cycle at its
  // only load-bearing point: a search now happens when the query or an option
  // changed, and at no other time.
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; });

  // Options are deliberately in here beside the query: a scope or case toggle is
  // a deliberate act on a query that is already typed, and making it wait for
  // the next keystroke reads as the toggle not working.
  useEffect(() => {
    const t = setTimeout(() => runRef.current(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, scope, glob, caseSensitive]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const groups = useMemo(() => (res ? groupByFile(res) : []), [res]);
  const needle = res?.query ?? '';

  const short = q.trim().length > 0 && q.trim().length < MIN_CHARS;

  return (
    <div className="fx-sr">
      <div className="fx-filter">
        <SearchIcon size={13} aria-hidden />
        <input
          ref={boxRef}
          type="search"
          value={q}
          placeholder={`Search file contents (${MIN_CHARS}+ characters)`}
          aria-label="Search file contents"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run(q); }}
        />
        {q && (
          <button type="button" className="fx-filter-x" aria-label="Clear the search"
            onClick={() => { setQ(''); setRes(null); boxRef.current?.focus(); }}>
            <X size={13} />
          </button>
        )}
      </div>

      <div className="fx-sr-opts">
        <label className="fx-sr-scope">
          <span className="fx-sr-lbl">in</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}
            aria-label="Which roots to search">
            <option value={ALL_ROOTS}>every root</option>
            {roots.map((r) => <option key={r.key} value={r.key}>{r.key}</option>)}
          </select>
        </label>
        <div className="fx-filter fx-sr-glob">
          <FileSearch size={13} aria-hidden />
          <input
            type="text"
            value={glob}
            placeholder="*.md"
            aria-label="Only files matching this name pattern"
            onChange={(e) => setGlob(e.target.value)}
          />
        </div>
        <Tooltip label={caseSensitive ? 'Matching case' : 'Ignoring case'}>
          <button
            type="button"
            className={`fx-sr-toggle ${caseSensitive ? 'on' : ''}`}
            aria-pressed={caseSensitive}
            aria-label="Match case"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            <CaseSensitive size={14} />
          </button>
        </Tooltip>
      </div>

      <div className="fx-sr-status" aria-live="polite">
        {busy ? 'Searching…'
          : short ? `${MIN_CHARS} characters or more`
          : err ? <span className="fx-sr-err">{err}</span>
          : res ? (
            res.matches.length
              ? `${res.matches.length} ${res.matches.length === 1 ? 'result' : 'results'} in ${groups.length} ${groups.length === 1 ? 'file' : 'files'} · ${res.scanned} scanned`
              : `Nothing matched in ${res.scanned} files`
          ) : ''}
      </div>

      {/* The cap, said out loud. A result list that quietly stops is how someone
          concludes a string is not on the box when it is only past the cutoff -
          the same reasoning as the tree's `truncated` flag. */}
      {res?.truncated && (
        <p className="fx-sr-cap">
          Stopped early ({res.truncated.reason}). These are the first
          {' '}{res.matches.length} of an unknown total — narrow the search.
        </p>
      )}

      <div className="fx-sr-list">
        {groups.map((g) => (
          <div className="fx-sr-group" key={`${g.root} ${g.path}`}>
            <button
              type="button"
              className="fx-sr-file"
              onClick={() => onOpen(g.root, g.path)}
              title={`${g.root}/${g.path}`}
            >
              <FileIcon name={g.path} size={13} />
              <span className="fx-sr-base">{baseName(g.path)}</span>
              <span className="fx-sr-dir">{dirName(g.path) || g.root}</span>
              <span className="fx-sr-n">{g.lines.length}</span>
            </button>
            {g.lines.map((l) => (
              <button
                type="button"
                key={l.line}
                className="fx-sr-line"
                onClick={() => onOpen(g.root, g.path,
                  { line: l.line, col: l.srcCol, len: needle.length })}
              >
                <span className="fx-sr-no">{l.line}</span>
                <span className="fx-sr-text">
                  <Marked text={l.text} col={l.col} len={needle.length} />
                </span>
              </button>
            ))}
            {g.lines.some((l) => l.more) && (
              <p className="fx-sr-more">…more matches in this file</p>
            )}
          </div>
        ))}

        {/* Name hits sit BELOW the content hits and are labelled, because they
            answer the other question. Unlabelled, a file with no visible line
            looks like a rendering failure. */}
        {!!res?.names.length && (
          <div className="fx-sr-group">
            <p className="fx-sr-sec">File names containing “{needle}”</p>
            {res.names.map((n) => (
              <button
                type="button"
                key={`${n.root} ${n.path}`}
                className="fx-sr-file"
                onClick={() => onOpen(n.root, n.path)}
                title={`${n.root}/${n.path}`}
              >
                <FileIcon name={n.path} size={13} />
                <span className="fx-sr-base">{baseName(n.path)}</span>
                <span className="fx-sr-dir">{dirName(n.path) || n.root}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
