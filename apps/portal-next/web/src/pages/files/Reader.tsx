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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BookOpen, ChevronLeft, FolderTree, GitCommitHorizontal, Pencil } from 'lucide-react';
import {
  isAuthError, listRoots, listTree, relDate,
  type FileRead, type FileRoot,
} from '../../lib/files';
import { ErrState } from '../../components/states';
import { Tooltip } from '../../components/Tooltip';
import { useMe } from '../../components/UserMenu';
import { hasRole } from '../../lib/me';
import { DocIndex, openTo, type RootTree } from './DocIndex';
import { FileView } from './FileView';
import { SearchView } from './Search';
import { SignInCard } from './SignInCard';
import { Start } from './Start';
import { Toc, useHeadings } from './Toc';
import { frontPageOf, noteRecent, readRecents, type Recent } from './start';
import { GUIDE_DIR, GUIDE_ROOT, defaultRoot, filesHref, type FilesMode } from './routes';
import { baseName, dirName, resolveWikiIn } from './tree';
import { fetchLinks, type LinkIndex } from '../../lib/files';

// shell.css carries the section scope (the full-height escape from `.content`,
// the inset focus ring and the syntax palette) and editor.css carries `.fx-read`
// and every `.md-*` rule - both of which belong to the RENDERED DOCUMENT rather
// than to the editor, which is why the reader gets them by importing rather than
// by copying. explorer.css is here for `.fx-filter`, the search box's frame.
// The syntax palette the five .hl-* classes in shell.css read, and the one
// cmtheme.ts hands to CodeMirror. Its own file since the theme editor's CSS
// pane started rendering code too - see src/hl.css.
import '../../hl.css';
import './shell.css';
import './editor.css';
import './explorer.css';
import './search.css';
import './read.css';

const LOADING: RootTree = { entries: [], truncated: false, loading: true, err: null };

export function Reader({ mode = 'read' }: {
  /** Which of the section's two reading destinations this is (routes.ts).
   *
   *  'guide' is Bothy's own manual: one root, one folder, and no control that
   *  offers to leave either. It is a MODE and not a second page - same Reader,
   *  same FileView, same renderer, same outline. What changes is what the side
   *  panel is pointed at, which is the whole of docs/plans/the-guide-and-the-
   *  reader.md §1: a manual carrying a root selector is a filesystem browser
   *  that happens to be showing a manual. */
  mode?: Extract<FilesMode, 'read' | 'guide'>;
} = {}) {
  const [params, setParams] = useSearchParams();
  const guide = mode === 'guide';
  // In guide mode both of these come from the ROUTE, not the query - filesHref
  // does not write them and filesTarget does not read them, so a hand-typed
  // `?root=notes` on /files/guide is ignored rather than half-honoured.
  const urlRoot = guide ? GUIDE_ROOT : (params.get('root') || '');
  const path = params.get('path') || '';
  // The folder the index is narrowed to. In the URL rather than in state so
  // that a scoped view is a thing you can send someone, and so Back steps out
  // of a folder the way it stepped in.
  const scope = guide ? GUIDE_DIR : (params.get('in') || '').replace(/^\/+|\/+$/g, '');
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

  // ── which folders are expanded (#150) ─────────────────────────────────────
  //
  // Here rather than in DocIndex, because the event that has to open one is the
  // READER's: following a cross-document link three folders deep must reveal the
  // route down to the new file, and the panel does not know a link was followed.
  //
  // NOT persisted. Pane widths and collapsed service groups are, and the
  // difference is that those are a layout you arranged; this is where you
  // happen to be in a tree, and restoring it a day later would reopen folders
  // for a document you are no longer reading.
  const [dirs, setDirs] = useState<Set<string>>(new Set());
  const toggleDir = useCallback((key: string) => {
    setDirs((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  // The `#heading` of a followed cross-document link. State and NOT the URL:
  // main.tsx mounts a HashRouter, so the whole route already lives after a `#`
  // and a second one would be ambiguous to the browser and to anyone pasting it.
  const [frag, setFrag] = useState('');
  const [file, setFile] = useState<FileRead | null>(null);

  // ── what this browser has read ────────────────────────────────────────────
  //
  // Read once, then kept in state and updated in place, so opening a document
  // does not re-parse localStorage and Start does not have to know it is backed
  // by a store at all.
  //
  // Recorded from the DOCUMENT'S OWN answer (`f.root`, `f.path`) rather than
  // from the URL, so a row only lands here for a file the service actually
  // served: a mistyped `?path=` renders "No such file", reports `null`, and
  // never becomes a row you can click again. `mergeRecent` drops an entry with
  // an empty root or path, which is also what makes the field being absent from
  // some future response a no-op instead of a `/files?root=&path=` row.
  const [recents, setRecents] = useState<Recent[]>(readRecents);
  const onFileLoad = useCallback((f: FileRead | null) => {
    setFile(f);
    if (f) setRecents(noteRecent(f.root, f.path));
  }, []);

  // Which of the two columns a NARROW screen is showing. On anything wide enough
  // for both this is inert - read.css only acts on it under the breakpoint. It
  // is the list/detail pattern, because the alternative on a 390px screen is an
  // index that occupies the phone and a document nobody can reach.
  //
  // 'doc' EVEN WITH NO PATH, which changed with Start: the main column is now
  // never empty, so landing a phone on the index would hide the landing surface
  // behind a tap. Start draws the same `.rd-back` control the document does, so
  // the index is still one tap away either way.
  const [pane, setPane] = useState<'index' | 'doc'>('doc');

  const docBox = useRef<HTMLDivElement | null>(null);
  const root = urlRoot;

  // ── the guide opens on the guide, without exception (#149) ────────────────
  //
  // `/files/guide` with no `?path=` lands on the manual's own front page rather
  // than on an interstitial. There is no Start surface in this mode on purpose:
  // docs/guide/index.md IS an index, and a landing page in front of an index
  // page is a chooser in front of a chooser.
  //
  // `replace`, so Back leaves the guide instead of bouncing off the bare URL -
  // the same treatment the default-root write already gets.
  useEffect(() => {
    if (!guide || path) return;
    const next = new URLSearchParams();
    next.set('path', `${GUIDE_DIR}/index.md`);
    setParams(next, { replace: true });
  }, [guide, path, setParams]);

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
  // Same fallback as the editor's, and now literally the same function: a
  // `?root=` naming a root that no longer exists lands on `defaultRoot(...)`
  // rather than rendering a 400 as if the service were broken. `replace`, so
  // Back does not bounce off the dead URL.
  useEffect(() => {
    const ac = new AbortController();
    listRoots(ac.signal)
      .then((r) => {
        setRoots(r.roots);
        setNeedsAuth(false);
        setRootsErr(null);
        if (!r.roots.length) return;
        // GUIDE MODE NEVER REWRITES THE URL. Its root is the route's, and
        // `defaultRoot` exists to answer "no usable ?root=" - a question
        // /files/guide does not ask. Left in, it would write `?root=notes` onto
        // the guide's URL on every arrival.
        if (guide) { setOpenRoots((prev) => (prev.size ? prev : new Set([GUIDE_ROOT]))); return; }
        const known = r.roots.some((x) => x.key === urlRoot);
        // Why this is not roots[0], and why absent `readOnly` means writable,
        // live with the rule in routes.ts - the reader is one of two callers and
        // the reasoning is not the reader's.
        const pick = known ? urlRoot : defaultRoot(r.roots);
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
  }, [tick, guide]);

  // ── the front page (issue #94) ────────────────────────────────────────────
  //
  // THIS USED TO BE A REDIRECT. Arriving at /files bounced you into the default
  // root's README, on the argument that a reader whose centre column is empty is
  // a filing cabinet rather than a reader. The argument was right; the
  // destination was not. `defaultRoot` picks the first WRITABLE root, which on
  // this box is `notes` - one person's private notes index - so "open Files"
  // meant "open somebody else's filing system", which is the complaint #94 was
  // filed about.
  //
  // The Start surface answers it instead, and the README survives as an OFFER
  // rather than a navigation: it is named, by path, in the empty state of the
  // recents list. `frontPageOf` is that same precedence order, moved into
  // start.ts where checks/start-table.mjs can assert it - it never was while it
  // was four lines inside an effect.
  //
  // Only the current root's UNSCOPED listing can answer this, which is why a
  // scoped index simply has no offer to make: `trees[root]` is not fetched while
  // `?in=` is set (the listing lives under a composite key), and '' renders as
  // no offer rather than as a broken one.
  const frontPage = useMemo(
    () => frontPageOf((trees[root]?.entries ?? []).map((e) => e.path)),
    [trees, root],
  );

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
    // Keyed by root AND scope: the same root narrowed to two different folders
    // is two different listings, and keying on the root alone would show the
    // first one forever.
    const keyOf = (k: string) => (k === root && scope ? `${k}\u0000${scope}` : k);
    const want = [...openRoots].filter((k) => !trees[keyOf(k)] && !inflight.current.has(keyOf(k)));
    if (!want.length) return;
    setTrees((prev) => {
      const next = { ...prev };
      for (const k of want) next[keyOf(k)] = LOADING;
      return next;
    });
    for (const k of want) {
      const ac = new AbortController();
      inflight.current.set(keyOf(k), ac);
      listTree(k, ac.signal, k === root ? scope : '')
        .then((r) => {
          if (ac.signal.aborted) return;
          inflight.current.delete(keyOf(k));
          setTrees((prev) => ({
            ...prev,
            [keyOf(k)]: { entries: r.files, truncated: !!r.truncated, loading: false, err: null },
          }));
        })
        .catch((e: unknown) => {
          if (ac.signal.aborted) return;
          inflight.current.delete(keyOf(k));
          if (isAuthError(e)) { setNeedsAuth(true); return; }
          setTrees((prev) => ({
            ...prev,
            [keyOf(k)]: { entries: [], truncated: false, loading: false, err: e instanceof Error ? e.message : String(e) },
          }));
        });
    }
    // `root` and `scope` are dependencies because keyOf() is built from them:
    // changing the scope changes which key this effect is looking for, and
    // without them the effect never re-runs, so the scoped listing is never
    // fetched and the index renders an empty folder. Caught exactly that way.
  }, [openRoots, trees, root, scope]);

  const openDoc = useCallback((r: string, p: string, at = '') => {
    const next = new URLSearchParams();
    // Guide URLs carry no `?root=` - filesHref makes that decision and this has
    // to make the same one, or opening a document would rewrite /files/guide
    // into a URL the route does not recognise.
    if (!guide) next.set('root', r);
    if (p) next.set('path', p);
    // THE FOLDER SCOPE SURVIVES OPENING A FILE (#152). It did not: this built a
    // fresh URLSearchParams and dropped `?in=`, so narrowing the index to a
    // folder and then clicking anything in it snapped the index back to the
    // whole root. `onScope` already preserves `path` for the symmetric reason -
    // narrowing the index changes what you are BROWSING, not what you are
    // reading - and the same reasoning was never applied the other way.
    if (!guide && scope && r === root) next.set('in', scope);
    setParams(next);
    setFrag(at);
    setPane('doc');
    // A root you opened a document in is a root you are reading, so its section
    // opens too - otherwise following a search result into `notes` leaves the
    // index showing a root the document is not in.
    setOpenRoots((prev) => (prev.has(r) ? prev : new Set(prev).add(r)));
  }, [setParams, guide, scope, root]);

  // Back to Start, keeping the root. The top nav's own Files link already goes
  // there from anywhere in the app (it points at a bare `/files`); this is the
  // way back from INSIDE a document, and it is the root segment of the
  // breadcrumb rather than a new control, because that is what a breadcrumb
  // already means and the alternative was a fourth thing in a 296px panel.
  const goStart = useCallback(() => {
    const next = new URLSearchParams();
    if (root) next.set('root', root);
    setParams(next);
    setPane('doc');
  }, [root, setParams]);

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

  // ── reveal the route down to the open document (#150) ─────────────────────
  //
  // On the PATH, not on the click. Doing it inside openDoc covered following a
  // link and missed the case that matters more: ARRIVING on a deep link, where
  // the folders are all shut and the open document has no row in the index at
  // all - `?path=docs/ARCHITECTURE.md` marked nothing, because `docs` was
  // closed. Measured exactly that way.
  //
  // Additive, never subtractive: a folder you opened by hand stays open when you
  // move to a document somewhere else, because collapsing the tree under
  // somebody as they navigate is the index taking the page back.
  useEffect(() => {
    if (!root || !path) return;
    setDirs((prev) => {
      const want = openTo(root, path);
      if (want.every((k) => prev.has(k))) return prev;
      const next = new Set(prev);
      for (const k of want) next.add(k);
      return next;
    });
  }, [root, path]);

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
      // The scoped listing lives under a composite key, which is this page's
      // business and not the panel's - so it is resolved into the plain root key
      // before it crosses the boundary.
      trees={scope ? { ...trees, [root]: trees[`${root}\u0000${scope}`] } : trees}
      openRoots={openRoots}
      onToggleRoot={toggleRoot}
      allFiles={allFiles}
      onAllFiles={setAllFiles}
      currentRoot={root}
      currentPath={path}
      onOpen={openDoc}
      onRetry={retryRoot}
      dirs={dirs}
      onToggleDir={toggleDir}
      guide={guide ? { root: GUIDE_ROOT, dir: GUIDE_DIR } : undefined}
      scope={guide ? '' : scope}
      onScope={guide ? undefined : (r, dir) => {
        // The scope goes in the URL, and the open document is kept: narrowing
        // the index is a change to what you are BROWSING, not to what you are
        // reading, and closing the document because you opened a folder would
        // be the reader losing your place to help you find it.
        const next = new URLSearchParams();
        next.set('root', r);
        if (dir) next.set('in', dir);
        if (path && r === root) next.set('path', path);
        setParams(next);
      }}
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
          <aside className="rd-side" aria-label={guide ? 'The guide' : 'Documents'}>
            {/* ── the one control that changes mode ────────────────────────
                Guide mode has no root picker (the-guide-and-the-reader.md §1),
                and this is not one: it is a DESTINATION, the same shape as the
                reader's Edit button. One link out of the manual, one link back
                into it, and nothing in either panel that half-offers the other
                mode's roots. */}
            <div className="rd-mode">
              {guide ? (
                <Link className="rd-mode-btn" to={filesHref('read', GUIDE_ROOT)}>
                  <FolderTree size={13} aria-hidden="true" /> Browse all files
                </Link>
              ) : (
                <Link className="rd-mode-btn" to={filesHref('guide', '')}>
                  <BookOpen size={13} aria-hidden="true" /> The Bothy guide
                </Link>
              )}
            </div>
            <SearchView
              roots={roots}
              // In the guide, the one root the guide is in - paired with
              // `within`, which confines the walk to its folder. Everywhere
              // else '*': every root that does not alias another, the service's
              // own token. A reader looking for a sentence does not know which
              // root it is in; that is the question search answers.
              root={guide ? GUIDE_ROOT : '*'}
              within={guide ? GUIDE_DIR : ''}
              controls={guide ? 'minimal' : 'full'}
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
                      {/* The root segment leads back to Start - the same thing
                          the root segment of the index's own breadcrumb does
                          for a folder scope. It keeps the crumb's exact
                          typography, so nothing moved; it just became
                          pressable. */}
                      <button
                        type="button"
                        className="rd-crumb-root"
                        onClick={goStart}
                        title="Start - Bothy's own docs, and where you were"
                      >
                        {root}
                      </button>
                      /{dirName(path)}<b>{baseName(path)}</b>
                    </p>
                    {/* A GLYPH, not a word. Editor.tsx:704 states the rule
                        where it is enforced - "chrome that spells itself out in
                        words is chrome that keeps taking width from the file" -
                        and the editor's own Edit control, one click away, is
                        this exact button with this exact icon. Two treatments
                        for one action was the only thing between them.

                        Still a <Link>, and `.fx-hbtn` is a class rather than an
                        element rule so it dresses an anchor unchanged. The
                        destination, the role gate and the `writable` check are
                        untouched; `aria-label` keeps the control named for
                        anyone not reading pixels, which the word did
                        implicitly. */}
                    {mayEdit && (
                      <Tooltip label="Edit this file" align="end">
                        <Link
                          className="fx-hbtn rd-edit"
                          to={filesHref('edit', root, path)}
                          aria-label="Edit this file"
                        >
                          <Pencil size={14} aria-hidden="true" />
                        </Link>
                      </Tooltip>
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
                    onLoad={onFileLoad}
                    // AFTER the document, never beside it. Backlinks are context
                    // you want once you have read the thing, and a sidebar of
                    // them competes with the outline for the same glance.
                    //
                    // A PROP AND NOT A SIBLING, which is the whole of #153: as a
                    // sibling it landed below `.fx-read`, and `.fx-read` is the
                    // element that scrolls - so the panel was docked to the
                    // bottom of the pane, in view at every scroll position, on
                    // every document. "After the document" and "below the
                    // document" are different places and the difference is
                    // invisible until you scroll.
                    footer={(
                      <Backlinks
                        index={graph[root] ?? null}
                        path={path}
                        onOpen={(p) => openDoc(root, p, undefined)}
                      />
                    )}
                  />
                </div>
              </>
            ) : guide ? (
              // One frame, at most: the effect above has already asked for the
              // front page. A skeleton here would flash on every arrival.
              null
            ) : (
              <Start
                roots={roots}
                root={root}
                frontPage={frontPage}
                recents={recents}
                onOpen={openDoc}
                onScope={(r, dir) => {
                  // Same URL shape as the index's own scope control, minus the
                  // `path` it preserves: there is no open document to keep when
                  // the shelf is what you pressed.
                  const next = new URLSearchParams();
                  next.set('root', r);
                  if (dir) next.set('in', dir);
                  setParams(next);
                  // The narrow screen has to MOVE to see what just happened -
                  // scoping changes the index, and the index is the other pane.
                  setPane('index');
                  setOpenRoots((prev) => (prev.has(r) ? prev : new Set(prev).add(r)));
                }}
                onIndex={() => setPane('index')}
              />
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
