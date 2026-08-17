// ── Files, as a reader ───────────────────────────────────────────────────────
//
// The default at `/files`. docs/plans/reading-first.md: markdown under docs/ and
// ~/claude-notes is 76 files and 9,141 lines, this page replaced a MkDocs site,
// and what the IDE showed on arrival was an empty centre, six keyboard shortcuts
// and a tree of 3,500 files. The tax of the editor's four regions was paid on
// every read, by everyone, to make the rarer case one click cheaper.
//
// So: a document, an index of documents, and its own headings. The IDE is
// unchanged at `/files/edit`, and both take the same `?root=&path=`.
//
// ── THE LINE THIS PAGE IS BUILT AROUND (§7) ──────────────────────────────────
//
// **Reading mode never writes.** Not "does not write yet". There is no draft
// here, no dirty flag, no conflict check, no save, no localStorage key. The
// failure mode that rule exists to prevent is this page growing a save button,
// then a dirty indicator, then a conflict dialog, until there are two editors
// and the second one is missing the mtime check that makes the first one safe.
// Its answer to every one of those is the Edit button, which is a LINK.
//
// The proof is mechanical rather than a promise: nothing in this module's import
// graph reaches writeFile, CodeSurface or Editor.tsx. FileContent takes its text
// surface as a prop for exactly this reason, so the reader hands it a
// highlighted `<pre>` and the editor hands it CodeMirror - and the reader never
// downloads CodeMirror's 332 kB chunk.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, GitCommitHorizontal, Pencil } from 'lucide-react';
import {
  isAuthError, listRoots, listTree, relDate,
  type FileRead, type FileRoot,
} from '../../lib/files';
import { ErrState } from '../../components/states';
import { useMe } from '../../components/UserMenu';
import { hasRole } from '../../lib/me';
import { DocIndex, type RootTree } from './DocIndex';
import { FileView } from './FileView';
import { SearchView } from './Search';
import { SignInCard } from './SignInCard';
import { Toc, useHeadings } from './Toc';
import { filesHref } from './routes';
import { baseName, dirName, resolveWikiIn } from './tree';
import { fetchLinks, type LinkIndex } from '../../lib/files';

// shell.css carries the section scope (the full-height escape from `.content`,
// the inset focus ring and the syntax palette) and editor.css carries `.fx-read`
// and every `.md-*` rule - both of which belong to the RENDERED DOCUMENT rather
// than to the editor, which is why the reader gets them by importing rather than
// by copying. explorer.css is here for `.fx-filter`, the search box's frame.
import './shell.css';
import './editor.css';
import './explorer.css';
import './search.css';
import './read.css';

const LOADING: RootTree = { entries: [], truncated: false, loading: true, err: null };

export function Reader() {
  const [params, setParams] = useSearchParams();
  const urlRoot = params.get('root') || '';
  const path = params.get('path') || '';
  const { me } = useMe();

  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [rootsErr, setRootsErr] = useState<string | null>(null);
  const [trees, setTrees] = useState<Record<string, RootTree | undefined>>({});
  // The link graph for the open root. One request per root, not per document:
  // the service builds it from a walk either way, and asking per-document would
  // repeat the expensive half while still not answering "what links here".
  //
  // Deliberately NOT awaited before the document renders. Backlinks are context
  // you read after the page, so blocking the page on them would trade the thing
  // people came for against the thing they might glance at.
  const [graph, setGraph] = useState<Record<string, LinkIndex | null>>({});

  const [openRoots, setOpenRoots] = useState<Set<string>>(new Set());
  const [allFiles, setAllFiles] = useState(false);
  const [tick, setTick] = useState(0);

  // The `#heading` of a followed cross-document link. State and NOT the URL:
  // main.tsx mounts a HashRouter, so the whole route already lives after a `#`
  // and a second one would be ambiguous to the browser and to anyone pasting it.
  const [frag, setFrag] = useState('');
  const [file, setFile] = useState<FileRead | null>(null);

  // Which of the two columns a NARROW screen is showing. On anything wide enough
  // for both this is inert - read.css only acts on it under the breakpoint. It
  // is the list/detail pattern, because the alternative on a 390px screen is an
  // index that occupies the phone and a document nobody can reach.
  const [pane, setPane] = useState<'index' | 'doc'>(path ? 'doc' : 'index');

  const docBox = useRef<HTMLDivElement | null>(null);
  const root = urlRoot;

  useEffect(() => {
    if (!root || root in graph) return;
    const ac = new AbortController();
    // `null` is written on failure as well as on success-with-nothing, because
    // both mean the same thing to this page - no panel - and leaving the key
    // absent would retry the request on every render.
    fetchLinks(root, ac.signal).then((g) => setGraph((m) => ({ ...m, [root]: g })));
    return () => ac.abort();
  }, [root, graph]);


  // ── the roots ──────────────────────────────────────────────────────────────
  //
  // Same fallback as the editor's: a `?root=` naming a root that no longer
  // exists lands on the first one rather than rendering a 400 as if the service
  // were broken. `replace`, so Back does not bounce off the dead URL.
  useEffect(() => {
    const ac = new AbortController();
    listRoots(ac.signal)
      .then((r) => {
        setRoots(r.roots);
        setNeedsAuth(false);
        setRootsErr(null);
        if (!r.roots.length) return;
        const known = r.roots.some((x) => x.key === urlRoot);
        // NOT roots[0]. The service returns them alphabetically, which put
        // `home` first - the one root that is read-only, holds ~4,000 entries,
        // and ALIASES every other root, so everything worth reading appeared
        // twice under a name that cannot be written to. Landing there was an
        // accident of sort order, and it made the reader open on the worst
        // possible listing.
        //
        // A writable root is the one somebody keeps documents in; `readOnly`
        // already travels with each root, so this needs nothing new from the
        // service. Falls back to whatever exists if every root is read-only.
        const best = r.roots.find((x) => !x.readOnly) ?? r.roots[0];
        const pick = known ? urlRoot : best.key;
        if (!known) {
          const next = new URLSearchParams();
          next.set('root', pick);
          setParams(next, { replace: true });
        }
        // The root you arrived in is the one open on arrival. The others are one
        // click, and each pays for its own listing - see the note in DocIndex.
        setOpenRoots((prev) => (prev.size ? prev : new Set([pick])));
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        if (isAuthError(e)) { setNeedsAuth(true); return; }
        setRootsErr(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
    // `urlRoot` is read but is deliberately not a dependency: the default-root
    // write is a one-shot that would otherwise re-fire on its own result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // ── the front page ────────────────────────────────────────────────────────
  //
  // Arriving at /files with no document used to show "Pick a document" beside
  // an index, which is a filing cabinet rather than a reader: the page had
  // nothing to read on it. A ROOT'S README IS ITS FRONT PAGE - ~/claude-notes
  // opens with a map of the notes, ~/stacks with the repo's own README - so if
  // the root has one, it is what the reader lands on.
  //
  // `replace`, so Back leaves the reader instead of bouncing between the empty
  // state and the document. Only when no path was asked for: a deep link always
  // wins, and this must never fight one.
  useEffect(() => {
    if (path || !root) return;
    const tree = trees[root];
    if (!tree || tree.loading || !tree.entries.length) return;
    const top = tree.entries.filter((e) => !e.path.includes('/'));
    const landing = ['README.md', 'readme.md', 'index.md', 'README.markdown']
      .map((n) => top.find((e) => e.path === n))
      .find(Boolean);
    if (!landing) return;
    const next = new URLSearchParams();
    next.set('root', root);
    next.set('path', landing.path);
    setParams(next, { replace: true });
  }, [path, root, trees, setParams]);

  // ── one listing per opened root ────────────────────────────────────────────
  //
  // Fetched when the section opens and kept for the life of the page. Nothing
  // here mutates a file, so a listing cannot go stale under this page's own
  // hands - the refresh is the Retry on a failed one.
  //
  // THE CONTROLLERS LIVE IN A REF, AND THIS EFFECT HAS NO CLEANUP THAT ABORTS
  // THEM. That is not an oversight, it is the fix for one: this effect writes
  // `trees` (the LOADING marker) and also depends on it, so a cleanup that
  // aborted would cancel the request it had just made, one commit later, on its
  // own state change - and the section would sit on its skeleton forever with a
  // net::ERR_ABORTED in the log and no error on screen. Measured, on `home`.
  // The only abort that is correct here is the one on unmount.
  const inflight = useRef(new Map<string, AbortController>());
  useEffect(() => () => { for (const ac of inflight.current.values()) ac.abort(); }, []);

  useEffect(() => {
    const want = [...openRoots].filter((k) => !trees[k] && !inflight.current.has(k));
    if (!want.length) return;
    setTrees((prev) => {
      const next = { ...prev };
      for (const k of want) next[k] = LOADING;
      return next;
    });
    for (const k of want) {
      const ac = new AbortController();
      inflight.current.set(k, ac);
      listTree(k, ac.signal)
        .then((r) => {
          if (ac.signal.aborted) return;
          inflight.current.delete(k);
          setTrees((prev) => ({
            ...prev,
            [k]: { entries: r.files, truncated: !!r.truncated, loading: false, err: null },
          }));
        })
        .catch((e: unknown) => {
          if (ac.signal.aborted) return;
          inflight.current.delete(k);
          if (isAuthError(e)) { setNeedsAuth(true); return; }
          setTrees((prev) => ({
            ...prev,
            [k]: { entries: [], truncated: false, loading: false, err: e instanceof Error ? e.message : String(e) },
          }));
        });
    }
  }, [openRoots, trees]);

  const openDoc = useCallback((r: string, p: string, at = '') => {
    const next = new URLSearchParams();
    next.set('root', r);
    if (p) next.set('path', p);
    setParams(next);
    setFrag(at);
    setPane('doc');
    // A root you opened a document in is a root you are reading, so its section
    // opens too - otherwise following a search result into `notes` leaves the
    // index showing a root the document is not in.
    setOpenRoots((prev) => (prev.has(r) ? prev : new Set(prev).add(r)));
  }, [setParams]);

  const toggleRoot = useCallback((k: string) => {
    setOpenRoots((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  }, []);

  const retryRoot = useCallback((k: string) => {
    inflight.current.delete(k);
    setTrees((prev) => {
      const next = { ...prev };
      delete next[k];
      return next;
    });
  }, []);

  const headings = useHeadings(docBox, `${root}\0${path}`);
  const last = file?.history?.[0] ?? null;

  // ── the Edit button (§2, step 5) ───────────────────────────────────────────
  //
  // ABSENT rather than disabled for someone who cannot write. A reader should not
  // carry a control that exists to be refused - a greyed Edit is a promise the
  // page has no way to keep, and it invites a click that produces a 403.
  //
  // `hasRole` is an INTERFACE decision and never a boundary. The file service
  // decides who may write, from a signed cookie, and would refuse this session
  // just as flatly if this line were deleted.
  //
  // The FILE's own answer is the second half, and it is not redundant: the
  // policy makes `home` and `projects` read-only roots and limits writes to a
  // handful of suffixes, so an `editor` looking at a .ts in `stacks`, or at
  // anything at all under `home`, would land in an editor with its own Edit
  // pencil already missing. Same rule as the role, applied to the other half of
  // the question - `writable` is what the read itself reported, so there is no
  // extra request to ask it.
  const mayEdit = hasRole(me, 'editor') && file?.writable === true;

  const index = (
    <DocIndex
      roots={roots}
      trees={trees}
      openRoots={openRoots}
      onToggleRoot={toggleRoot}
      allFiles={allFiles}
      onAllFiles={setAllFiles}
      currentRoot={root}
      currentPath={path}
      onOpen={openDoc}
      onRetry={retryRoot}
    />
  );

  return (
    <div className="bothy-files bothy-read" data-pane={pane}>
      {needsAuth ? (
        <div className="fx-gate"><SignInCard what="read the box" onRetry={() => setTick((t) => t + 1)} /></div>
      ) : rootsErr ? (
        <div className="fx-gate">
          <ErrState
            title="Cannot reach the file service"
            body={`/-/api/files did not answer (${rootsErr}). Nothing on this page can load until it does.`}
            onRetry={() => setTick((t) => t + 1)}
          />
        </div>
      ) : (
        <div className="rd-grid">
          {/* ── the side panel ──────────────────────────────────────────────
              Search at the TOP, not behind an icon (§3), and it is the editor's
              own SearchView rather than a second one. The index rides in its
              `idle` slot, so the two share one scroll container and results
              replace the index instead of pushing it off the screen. */}
          <aside className="rd-side" aria-label="Documents">
            <SearchView
              roots={roots}
              // '*' - every root that does not alias another, which is the
              // service's own token. A reader looking for a sentence does not
              // know which root it is in; that is the question search answers.
              root="*"
              onOpen={(r, p) => openDoc(r, p)}
              onNeedsAuth={() => setTick((t) => t + 1)}
              idle={index}
            />
          </aside>

          <main className="rd-main" aria-label="Document">
            {path ? (
              <>
                {/* ── the header, and the title it deliberately does NOT carry ──
                    A derived title here would be printed directly above the
                    document's own `# heading`, which is the same words twice,
                    ninety pixels apart - and worse than twice when they
                    disagree: `~/claude-notes/README.md` would read "README"
                    above "Claude notes - map", labelling the document with the
                    one name that says nothing about it.

                    md.tsx has always shifted heading levels down one "because
                    the shell already owns the document title". In the editor
                    that was not true of anything on screen. Here it is: the
                    document's own first heading IS the title, rendered by the
                    renderer, and this strip is its address and its provenance.
                    The prettified title still earns its place in the index,
                    where there is no document to speak for itself. */}
                <header className="rd-head">
                  <button
                    type="button"
                    className="rd-back"
                    onClick={() => setPane('index')}
                    aria-label="Back to the documents"
                  >
                    <ChevronLeft size={14} aria-hidden="true" /> Documents
                  </button>
                  <div className="rd-head-row">
                    <p className="rd-crumb mono" title={`${root}/${path}`}>
                      {root}/{dirName(path)}<b>{baseName(path)}</b>
                    </p>
                    {mayEdit && (
                      <Link className="btn sm rd-edit" to={filesHref('edit', root, path)}>
                        <Pencil size={13} aria-hidden="true" /> Edit
                      </Link>
                    )}
                  </div>
                  {/* One provenance line, not the inspector's eleven facts. The
                      editor's answer to "what is this file" is a panel; a
                      reader's is a sentence. */}
                  {last ? (
                    <p className="rd-prov">
                      <GitCommitHorizontal size={13} aria-hidden="true" />
                      <span className="rd-prov-t">
                        Last changed <b title={last.date}>{relDate(last.date)}</b> by {last.author}
                        {' - '}{last.subject}
                      </span>
                      <span className="rd-sha mono">{last.sha.slice(0, 7)}</span>
                    </p>
                  ) : file ? (
                    // No history is a FACT about the file (untracked, or outside
                    // a work tree), not a gap in the page.
                    <p className="rd-prov">
                      <GitCommitHorizontal size={13} aria-hidden="true" />
                      <span className="rd-prov-t">Not in a git history{file.versioned === false ? ' - this root is not a work tree' : ' yet'}.</span>
                    </p>
                  ) : null}
                </header>

                <div className="rd-body" ref={docBox}>
                  <FileView
                    root={root}
                    path={path}
                    frag={frag}
                    // A cross-document link stays in the READER. That is the
                    // whole point of step 3 landing before this page:
                    // ~/claude-notes is built out of relative links, and a
                    // documentation site whose links do not click is not one.
                    onOpen={(p, at) => openDoc(root, p, at)}
                    // Wikilinks resolve against the CURRENT root's listing,
                    // which this page already has for the index beside it. Only
                    // that root: `[[dns]]` in a note means the note called dns,
                    // and reaching into another root to find one would make the
                    // same link mean different things depending on what happened
                    // to be loaded.
                    resolveWiki={(t) => resolveWikiIn(
                      (trees[root]?.entries ?? []).map((e) => e.path), t,
                    )}
                    onLoad={setFile}
                  />
                  {/* AFTER the document, never beside it. Backlinks are context
                      you want once you have read the thing, and a sidebar of
                      them competes with the outline for the same glance. */}
                  <Backlinks
                    index={graph[root] ?? null}
                    path={path}
                    onOpen={(p) => openDoc(root, p, undefined)}
                  />
                </div>
              </>
            ) : (
              <div className="rd-empty">
                <h2>Pick a document</h2>
                <p>
                  Everything readable on the box, ordered by what it is for: prose first,
                  then the rest behind <b>All files</b>. Search reads the bytes of every
                  root, so a phrase you half-remember is enough.
                </p>
                <p className="rd-empty-note">
                  This view never writes. The editor is at{' '}
                  <Link to={filesHref('edit', root)}>/files/edit</Link>.
                </p>
              </div>
            )}
          </main>

          {/* The outline renders nothing for a document with fewer than two
              headings, and nothing at all for a kind that has none - so this
              column is empty for an image or a JSON file without either side
              having to know which kinds have headings. */}
          <Toc headings={headings} box={docBox} />
        </div>
      )}
    </div>
  );
}

/** "3 documents link here", and which ones.
 *
 *  WHY THIS IS WORTH A PANEL. A note in ~/claude-notes is written as if the
 *  reader arrived from somewhere - "see the naming note" - and the reverse
 *  question, "what refers to this", has no answer anywhere else on the box. The
 *  index makes it a lookup; without it you are grepping.
 *
 *  It renders NOTHING when there is nothing to say. A panel reading "0 documents
 *  link here" is a row of furniture on every orphan, and this reader's whole
 *  argument is that the rarer case should not tax the common one.
 */
function Backlinks({ index, path, onOpen }: {
  index: LinkIndex | null;
  path: string;
  onOpen: (path: string) => void;
}) {
  if (!index) return null;
  const doc = index.docs[path];
  const from = doc?.in ?? [];
  if (!from.length) return null;

  return (
    <section className="rd-backlinks" aria-label="Documents that link here">
      <h2>
        {from.length} document{from.length === 1 ? '' : 's'} link
        {from.length === 1 ? 's' : ''} here
      </h2>
      <ul>
        {from.map((p) => (
          <li key={p}>
            {/* A button, not a link, for the reason md.tsx gives at length:
                there is no URL for a file inside a root, and writing one would
                be inventing an href this page cannot honour. */}
            <button type="button" onClick={() => onOpen(p)} title={p}>
              <span className="rd-bl-title">{index.docs[p]?.title || baseName(p)}</span>
              <span className="rd-bl-path mono">{p}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
