// BothyFiles - an IDE over the box, in the portal's chrome.
//
// Four regions, because the page answers four questions and they are not the
// same question:
//
//   WHICH file    the explorer, left. Persistent: you pick files repeatedly.
//   WHAT it says  the viewer/editor, centre. The only region that changes mode.
//   WHAT IT IS    the inspector, right - facts, git history, the commit form and
//                 the ways to get the bytes off the box.
//   WHAT WENT ON  the panel, bottom. Problems, the API log, the repo's history.
//
// Only the centre is unsized: the two rails and the panel carry a stored width
// or height and the centre is `minmax(0, 1fr)`, so it absorbs the remainder. See
// panes.ts for why that is the only arrangement without a reconciliation bug.
//
// EVERYTHING here needs a session. The roots cover the stacks repo, the notes
// and ~/projects, which hold real secrets, so `viewer` is required to read and
// `editor` to save. A 401 from any call is therefore an INVITATION, not an
// error, and it is handled in exactly one shape (SignInCard) wherever it lands.
//
// ── THE DOCUMENT MODEL ───────────────────────────────────────────────────────
//
// This page used to hold exactly ONE open file: one `file`, one `draft`, one
// `editing`, driven straight off `?root=`/`?path=`, with the unsaved-changes
// guard sitting on the single navigation that changed them. Everything
// downstream assumed one document.
//
// It now holds a WORKSPACE: an ordered list of documents, one or two groups
// that each own a slice of that list, and a focused group. The whole of it is
// ONE piece of state on purpose - every transition (open, focus, close, move,
// split, collapse) touches the list, the groups and the focus together, and
// three separate `useState`s would mean three updaters that can be interleaved
// or double-invoked into a workspace that never existed. `next(fn)` below is
// the only way in, and every helper it takes is a pure function of the previous
// workspace.
//
// Three consequences worth stating, because each replaces a rule that used to
// be written the other way round:
//
//   · THE DIRTY GUARD MOVED FROM SWITCH TO CLOSE. Switching away from a
//     document with unsaved changes is now free - that is what tabs are for.
//     Closing one is the only action that can still throw work away, so it is
//     the only one that asks.
//   · THE URL CARRIES THE ACTIVE DOCUMENT, unchanged in shape: `?root=&path=`.
//     Existing links, the explorer's reveal and the browser's Back all keep
//     working. The EXPLORER's root is separate state (`browseRoot`), because
//     browsing another root no longer closes what you have open.
//   · EVERY DOCUMENT STAYS MOUNTED (see Editor.tsx). That is what lets undo
//     history survive a tab switch, which the old `key={docKey}` destroyed.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PanelBottom, PanelLeft, PanelRight } from 'lucide-react';
import {
  ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_MEMBER, ARCHIVE_MAX_TOTAL,
  archiveUrl, fileHistory, fmtBytes, gitDiff, gitStatus, isAuthError, langFor,
  listRepos, listRoots, listTree, logCall,
  onApiCall, openDownload, rawUrl, readFile, writeFile,
  type ApiCall, type Commit, type DiffResult, type FileRoot,
  type RepoInfo, type StatusResult, type TreeFile,
} from '../../lib/files';
import { ErrState } from '../../components/states';
import { Tooltip } from '../../components/Tooltip';
import { ActivityBar, type RailView } from './ActivityBar';
import { Explorer, MAX_RESULTS, type Results } from './Explorer';
import { Editor, isDirty, type Doc, type Group, type View } from './Editor';
import type { CodeHandle } from './CodeSurface';
import type { DiffTarget } from './Diff';
import { Inspector } from './Inspector';
import { matches } from './keys';
import { Panel, type PanelTab, type Problem } from './Panel';
import { Resizer } from './Resizer';
import { SignInCard } from './SignInCard';
import { SourceControl } from './SourceControl';
import { decorate, NO_DECORATIONS, type Change } from './gitdeco';
import { usePanes } from './panes';
import { ancestorsOf, baseName, buildTree, defaultMessage, type Node } from './tree';

import './shell.css';
import './explorer.css';
import './editor.css';
import './inspector.css';
import './panel.css';
import './scm.css';

const MAX_CALLS = 200;

// A stable identity for "no deletions", so the common case does not hand
// buildTree a new Set on every status refresh and rebuild the whole tree.
const NO_TOMBS: Set<string> = new Set();

// The diff target is a DEPENDENCY of the fetch effect below, so its identity is
// the request. A fresh object for a target that has not changed is a second
// round trip for the same bytes - which is what clicking the already-active
// Working/Staged segment used to do. Every setter goes through this.
const sameDiff = (a: DiffTarget | null, b: DiffTarget | null) =>
  a === b || (!!a && !!b && a.root === b.root && a.path === b.path
    && a.staged === b.staged && a.untracked === b.untracked);

// ── the workspace, and the pure transitions on it ────────────────────────────

interface Workspace {
  docs: Doc[];
  /** One or two. Three is a tiling window manager, not an editor, and none of
   *  them is readable at this page's width. */
  groups: Group[];
  focus: number;
  /** The id counter. Ids are NOT root+path: two tabs on one file are legal, and
   *  the draft they share is keyed by root+path (docs/kb/editor-drafts.md)
   *  precisely because one FILE has one draft however many tabs point at it. */
  seq: number;
}

const EMPTY_WS: Workspace = { docs: [], groups: [{ tabs: [], active: null }], focus: 0, seq: 1 };

function newDoc(id: string, root: string, path: string): Doc {
  return {
    id, root, path, state: 'new', file: null, err: null,
    editing: false, draft: '', view: 'preview', message: '',
    notice: null, conflict: null, saving: false,
  };
}

/** Drop a tab from a group and pick its successor. The tab that takes its place
 *  is the one to its RIGHT, falling back to its left - the same choice every
 *  editor makes, and the one that keeps a rapid close-close-close sequence
 *  moving in a single direction. */
function withoutTab(g: Group, id: string): Group {
  if (!g.tabs.includes(id)) return g;
  const at = g.tabs.indexOf(id);
  const tabs = g.tabs.filter((t) => t !== id);
  return { tabs, active: g.active === id ? (tabs[at] ?? tabs[at - 1] ?? null) : g.active };
}

/** A group that has lost its last tab stops existing, and the split collapses
 *  back to one column. An empty group holding a divider is a piece of furniture
 *  with nothing behind it. The SOLE group is allowed to be empty - that is the
 *  page at rest, and it renders the empty state. */
function collapseEmpty(w: Workspace): Workspace {
  if (w.groups.length < 2) return w;
  const empty = w.groups.findIndex((g) => g.tabs.length === 0);
  if (empty < 0) return w;
  return { ...w, groups: w.groups.filter((_, i) => i !== empty), focus: 0 };
}

function removeDoc(w: Workspace, id: string): Workspace {
  return collapseEmpty({
    ...w,
    docs: w.docs.filter((d) => d.id !== id),
    groups: w.groups.map((g) => withoutTab(g, id)),
  });
}

function moveDoc(w: Workspace, id: string, to: number): Workspace {
  const from = w.groups.findIndex((g) => g.tabs.includes(id));
  if (from < 0 || from === to || to < 0 || to >= w.groups.length) return w;
  return collapseEmpty({
    ...w,
    groups: w.groups.map((g, i) => {
      if (i === from) return withoutTab(g, id);
      if (i === to) return { tabs: [...g.tabs, id], active: id };
      return g;
    }),
    focus: to,
  });
}

/** Make the split, with this document in the new group. Refused when the source
 *  group holds only this one tab: it would empty, collapseEmpty would merge it
 *  straight back, and the gesture would be an animation with no result. */
function splitOff(w: Workspace, id: string): Workspace {
  if (w.groups.length > 1) {
    const to = w.groups.findIndex((g) => !g.tabs.includes(id));
    return to < 0 ? w : moveDoc(w, id, to);
  }
  const from = w.groups.findIndex((g) => g.tabs.includes(id));
  if (from < 0 || w.groups[from].tabs.length < 2) return w;
  return { ...w, groups: [withoutTab(w.groups[from], id), { tabs: [id], active: id }], focus: 1 };
}

export function Files() {
  const [params, setParams] = useSearchParams();
  const urlRoot = params.get('root') || '';
  const urlPath = params.get('path') || '';

  const { panes, setSize, nudge, reset, toggle } = usePanes();

  // The EXPLORER's root. Separate from the active document's root now that
  // browsing elsewhere no longer closes what is open - and seeded from the URL,
  // so a `?root=` link still lands where it says.
  const [browseRoot, setBrowseRoot] = useState(urlRoot);
  const root = browseRoot;

  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [entries, setEntries] = useState<TreeFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeErr, setTreeErr] = useState<string | null>(null);
  // One flag for "the session is missing", set by whichever call found out.
  const [needsAuth, setNeedsAuth] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');

  const [ws, setWs] = useState<Workspace>(EMPTY_WS);
  // The latest workspace, for the handlers that must read it without being
  // rebuilt whenever it changes - the window key listener above all, which would
  // otherwise re-subscribe on every keystroke typed into a document.
  const wsRef = useRef(ws);
  useEffect(() => { wsRef.current = ws; });

  const groups = ws.groups;
  const activeId = groups[ws.focus]?.active ?? null;
  const active = useMemo(() => ws.docs.find((d) => d.id === activeId) ?? null, [ws.docs, activeId]);
  const activePath = active && active.root === root ? active.path : '';

  // The document whose CLOSE is waiting on an answer. Holds an id rather than a
  // navigation now: switching is free, and closing is the only thing left that
  // can discard work.
  const [pending, setPending] = useState<string | null>(null);
  // Which group is showing the diff overlay. Fixed when it opens, so a diff does
  // not hop across the split the moment focus moves.
  const [diffGroup, setDiffGroup] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);

  const next = useCallback((fn: (w: Workspace) => Workspace) => setWs(fn), []);

  const patchDoc = useCallback((id: string, fn: (d: Doc) => Doc) => {
    setWs((w) => ({ ...w, docs: w.docs.map((d) => (d.id === id ? fn(d) : d)) }));
  }, []);

  // ── the git area ───────────────────────────────────────────────────────────
  //
  // The rail is one column with two occupants, chosen by the activity bar. The
  // STATUS behind it is fetched either way, because the explorer's decorations
  // need it as much as the panel does - a colour that only appears once you
  // open Source Control is a colour nobody sees.
  const [railView, setRailView] = useState<RailView>('explorer');
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [reposErr, setReposErr] = useState<string | null>(null);
  // '' means "follow the open file". Set only when the user picks a repository
  // explicitly, so the panel does not fight the file being browsed.
  const [pickedRepo, setPickedRepo] = useState('');
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [statusTick, setStatusTick] = useState(0);

  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [diffRes, setDiffRes] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffErr, setDiffErr] = useState<string | null>(null);

  const [calls, setCalls] = useState<ApiCall[]>([]);
  // Problems the page RAISED rather than observed - a refused download, a
  // preview that had to fall back. API failures are derived from `calls`; these
  // cannot be, because no request was made.
  const [raised, setRaised] = useState<Problem[]>([]);
  const [tab, setTab] = useState<PanelTab>('problems');
  const [repoLog, setRepoLog] = useState<Commit[] | null>(null);

  // An imperative handle PER DOCUMENT rather than one for the page. The text
  // surface is a CodeMirror instance whose editable element is a contenteditable
  // div the page never touches directly, and every open document now has one
  // mounted at the same time - so a single shared ref would be owned by
  // whichever surface mounted last, and Find would search the wrong file.
  const handles = useRef(new Map<string, React.RefObject<CodeHandle | null>>());
  const handleFor = useCallback((id: string) => {
    let h = handles.current.get(id);
    if (!h) { h = { current: null }; handles.current.set(id, h); }
    return h;
  }, []);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  // Every in-flight read, so closing a tab stops its fetch rather than letting
  // it land on a document that no longer exists.
  const aborts = useRef(new Map<string, AbortController>());
  useEffect(() => () => { for (const ac of aborts.current.values()) ac.abort(); }, []);

  const dirtyDocs = useMemo(() => ws.docs.filter(isDirty), [ws.docs]);
  // `dirtyHere` - the unsaved paths in the browsed root - lived here. Its only
  // two readers were Source Control's dirty markers and the refusal that stopped
  // a discard destroying the disk copy of a file a tab still held. Both are gone
  // with discard itself; `dirtyDocs` below still guards the page unload.

  // ── the call log ───────────────────────────────────────────────────────────
  // Subscribed once, for the life of the page. Newest first, capped - an
  // unbounded log on a page nobody reloads is a slow leak.
  useEffect(() => onApiCall((c) => setCalls((prev) => [c, ...prev].slice(0, MAX_CALLS))), []);

  const raise = useCallback((p: Problem) => {
    setRaised((prev) => (prev.some((x) => x.id === p.id) ? prev : [p, ...prev].slice(0, 50)));
  }, []);

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
        if (!urlRoot || !r.roots.some((x) => x.key === urlRoot)) {
          const nextParams = new URLSearchParams();
          nextParams.set('root', r.roots[0].key);
          setParams(nextParams, { replace: true });
          setBrowseRoot(r.roots[0].key);
        }
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        if (isAuthError(e)) { setNeedsAuth(true); setTreeLoading(false); return; }
        setTreeErr(e instanceof Error ? e.message : String(e));
        setTreeLoading(false);
      });
    return () => ac.abort();
    // `urlRoot` is read but deliberately not a dependency: this runs once, and
    // the default-root write above is a one-shot that would otherwise re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTick]);

  useEffect(() => {
    if (!root) return;
    const ac = new AbortController();
    setTreeLoading(true);
    listTree(root, ac.signal)
      .then((r) => {
        setEntries(r.files);
        setTruncated(!!r.truncated);
        setTreeErr(null);
        setNeedsAuth(false);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setEntries([]);
        if (isAuthError(e)) { setNeedsAuth(true); setTreeErr(null); return; }
        setTreeErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!ac.signal.aborted) setTreeLoading(false); });
    return () => ac.abort();
  }, [root, reloadTick]);

  // The whole root's git log, for the panel's Git tab. `path='.'` is what the
  // service accepts for "the repository" - an empty path is a 403 ("empty
  // path"), measured against the live endpoint, so the dot is load-bearing.
  useEffect(() => {
    if (!root) return;
    const ac = new AbortController();
    setRepoLog(null);
    fileHistory(root, '.', ac.signal)
      .then((r) => setRepoLog(r.history))
      .catch(() => { if (!ac.signal.aborted) setRepoLog([]); });
    return () => ac.abort();
  }, [root, reloadTick]);

  // ── which repository the git area is about ─────────────────────────────────
  //
  // A ROOT IS NOT A REPOSITORY, and on this box that is the ordinary case rather
  // than the exception: `home` and `projects` are directories holding several
  // repos and are not repos themselves. So the panel has to name one, and the
  // default has to be the one the user is already looking at.
  useEffect(() => {
    if (!root) return;
    const ac = new AbortController();
    setRepos(null);
    setReposErr(null);
    listRepos(root, '', ac.signal)
      .then((r) => setRepos(r.repos))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setRepos([]);
        // 401 is already said once, by the tree. Repeating it here would put two
        // sign-in prompts on one screen.
        if (!isAuthError(e)) setReposErr(e instanceof Error ? e.message : String(e));
      });
    return () => ac.abort();
  }, [root, reloadTick]);

  // The repo covering a path: the LONGEST repo path that contains it. Longest,
  // not first, because `projects` holds nested checkouts and the innermost one
  // is the one a file actually belongs to.
  const repoForPath = useCallback((list: RepoInfo[], p: string): RepoInfo | null => {
    let best: RepoInfo | null = null;
    let bestLen = -1;
    for (const r of list) {
      const rp = r.path === '.' ? '' : r.path.replace(/\/+$/, '');
      if (rp && p !== rp && !p.startsWith(`${rp}/`)) continue;
      if (rp.length > bestLen) { best = r; bestLen = rp.length; }
    }
    return best;
  }, []);

  const repo = useMemo(() => {
    if (!repos) return null;
    if (pickedRepo) return repos.find((r) => r.path === pickedRepo) ?? null;
    return (activePath ? repoForPath(repos, activePath) : null) ?? repos[0] ?? null;
  }, [repos, pickedRepo, activePath, repoForPath]);

  // What every git call is scoped to. A path inside the repo is enough - the
  // service derives the repository from it, which is why no client ever names a
  // directory as a repo.
  const scope = repo ? repo.path : (activePath || '');

  useEffect(() => {
    if (!root) return;
    const ac = new AbortController();
    setStatusLoading(true);
    gitStatus(root, scope, ac.signal)
      .then((s) => { setStatus(s); setStatusErr(null); })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setStatus(null);
        if (!isAuthError(e)) setStatusErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!ac.signal.aborted) setStatusLoading(false); });
    return () => ac.abort();
  }, [root, scope, statusTick, reloadTick]);

  // The diff, whenever one is open. Refetched on `statusTick` too: staging a
  // file moves its whole content across the staging line, so a diff left open
  // beside that action would otherwise be describing the world as it was.
  useEffect(() => {
    if (!diff) { setDiffRes(null); setDiffErr(null); return; }
    const ac = new AbortController();
    setDiffLoading(true);
    setDiffErr(null);
    gitDiff(diff.root, diff.path, diff.staged, ac.signal)
      .then((d) => setDiffRes(d))
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setDiffRes(null);
        setDiffErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!ac.signal.aborted) setDiffLoading(false); });
    return () => ac.abort();
  }, [diff, statusTick]);

  // ── reading documents ──────────────────────────────────────────────────────
  //
  // ONE effect for the whole list rather than one per document, because a
  // document is a row in an array and hooks cannot be. Anything marked 'new' has
  // never been read (or has been marked for a re-read after git moved it on
  // disk); this picks those up, flips them to 'loading' so they are picked up
  // exactly once, and fills them in as they land.
  useEffect(() => {
    const fresh = ws.docs.filter((d) => d.state === 'new');
    if (!fresh.length) return;
    setWs((w) => ({ ...w, docs: w.docs.map((d) => (d.state === 'new' ? { ...d, state: 'loading' } : d)) }));
    for (const d of fresh) {
      aborts.current.get(d.id)?.abort();
      const ac = new AbortController();
      aborts.current.set(d.id, ac);
      readFile(d.root, d.path, ac.signal)
        .then((f) => {
          if (ac.signal.aborted) return;
          // Every mode/draft/notice reset for a document lives here, so there is
          // exactly one place that decides what "this document was (re)read"
          // means. It is only ever reached for a document that is NOT being
          // edited - see rereadAll.
          patchDoc(d.id, (cur) => ({
            ...cur,
            state: 'ready', file: f, err: null,
            editing: false, draft: f.content ?? '', view: 'preview',
            notice: null, conflict: null,
            message: defaultMessage(f.path, langFor(f.path, f.lang)),
          }));
        })
        .catch((e: unknown) => {
          if (ac.signal.aborted) return;
          patchDoc(d.id, (cur) => (isAuthError(e)
            ? { ...cur, state: 'auth', file: null, err: null }
            : { ...cur, state: 'error', file: null, err: e instanceof Error ? e.message : String(e) }));
        });
    }
  }, [ws.docs, patchDoc]);

  // `rereadAll` lived here: re-read every open document a git mutation may have
  // moved under the editor. Its only caller was the mutation handler, and with
  // no verb on this page nothing changes a file behind an open tab any more.

  // ── open or focus ──────────────────────────────────────────────────────────
  //
  // What `pick()` became. A file that is already open is FOCUSED wherever it
  // lives - including in the other group - rather than opened a second time.
  const openOrFocus = useCallback((r: string, p: string) => {
    if (!r || !p) return;
    next((w) => {
      const found = w.docs.find((d) => d.root === r && d.path === p);
      if (found) {
        const gi = w.groups.findIndex((g) => g.tabs.includes(found.id));
        if (gi < 0) return w;
        if (w.focus === gi && w.groups[gi].active === found.id) return w;
        return { ...w, focus: gi, groups: w.groups.map((g, i) => (i === gi ? { ...g, active: found.id } : g)) };
      }
      const id = `d${w.seq}`;
      const gi = w.focus;
      return {
        docs: [...w.docs, newDoc(id, r, p)],
        groups: w.groups.map((g, i) => (i === gi ? { tabs: [...g.tabs, id], active: id } : g)),
        focus: gi,
        seq: w.seq + 1,
      };
    });
  }, [next]);

  const forget = useCallback((id: string) => {
    aborts.current.get(id)?.abort();
    aborts.current.delete(id);
    handles.current.delete(id);
  }, []);

  // The guard, in the one place it still belongs. `force` is only ever passed by
  // the banner's own Discard button.
  const closeDoc = useCallback((id: string, force = false) => {
    const d = wsRef.current.docs.find((x) => x.id === id);
    if (!d) return;
    if (!force && isDirty(d)) { setPending(id); return; }
    setPending((p) => (p === id ? null : p));
    forget(id);
    next((w) => removeDoc(w, id));
  }, [forget, next]);

  const resolvePending = useCallback((discard: boolean) => {
    const id = pending;
    setPending(null);
    if (discard && id) closeDoc(id, true);
  }, [pending, closeDoc]);

  // ── the URL ────────────────────────────────────────────────────────────────
  //
  // The URL is an INPUT to the read effect and an OUTPUT of the write effect, so
  // the two have to be kept from answering each other. `synced` is the one value
  // they have both already agreed on; whichever side moves first claims it, and
  // the other recognises the next change as its own echo and stops.
  //
  // Comparing the URL against the active document instead - which is what this
  // did - CANNOT work, and shipped as an infinite loop that blanked the page.
  // The two effects run in the same commit, and on a URL change the write sees
  // the active document from BEFORE the read's openOrFocus has committed. So it
  // wrote the old document back over the new URL, the read opened the new one
  // again, and the two ping-ponged - measured at ~4 flips a second, each one a
  // history entry, until React gave up at 50 nested updates and unmounted the
  // tree. React error #185, and a white page.
  const synced = useRef<string | null>(null);
  // What the URL has asked for and the workspace has not produced YET.
  //
  // A value comparison alone cannot settle this, because the deciding fact is
  // not what the two sides hold but WHICH ONE MOVED - and "the URL changed, the
  // workspace has not caught up" and "the workspace changed, the URL has not
  // caught up" look identical from either side. Only the read effect knows it
  // was the mover, so it says so here.
  const awaiting = useRef<string | null>(null);

  // Read: a `?path=` opens or focuses that document, which is what makes an
  // existing deep link, the explorer's reveal and the browser's Back button all
  // keep working with no new scheme.
  useEffect(() => {
    const key = `${urlRoot}\0${urlPath}`;
    if (key === synced.current) return;
    synced.current = key;
    if (!urlPath) {
      awaiting.current = null;
      if (urlRoot) setBrowseRoot((b) => (b === urlRoot ? b : urlRoot));
      return;
    }
    awaiting.current = key;
    openOrFocus(urlRoot, urlPath);
  }, [urlRoot, urlPath, openOrFocus]);

  // Written: the active document, or the browsed root when nothing is open.
  //
  // `urlRoot`/`urlPath` are deliberately NOT dependencies. A URL change must not
  // be able to trigger a write - that is precisely the edge the loop rode in on.
  // This effect answers to the workspace and to nothing else.
  useEffect(() => {
    const r = active ? active.root : browseRoot;
    const p = active ? active.path : '';
    if (!r) return;
    const key = `${r}\0${p}`;
    // The URL asked for a document. Until it arrives, the workspace is simply
    // BEHIND, and writing what it currently holds would erase the request - on
    // first paint that meant a deep link opened nothing, because the workspace
    // is empty for exactly one commit while the read effect's open is landing.
    if (awaiting.current !== null) {
      if (key !== awaiting.current) return;
      awaiting.current = null;
      return;
    }
    if (key === synced.current) return;
    synced.current = key;
    const nextParams = new URLSearchParams();
    nextParams.set('root', r);
    if (p) nextParams.set('path', p);
    setParams(nextParams);
  }, [active, browseRoot, setParams]);

  // A deep link into a nested file must arrive with its folders already open,
  // or the tree shows the reader a closed root and no sign of where they are.
  useEffect(() => {
    if (!activePath) return;
    setExpanded((prev) => {
      const nextSet = new Set(prev);
      for (const a of ancestorsOf(activePath)) nextSet.add(a);
      return nextSet;
    });
  }, [activePath]);

  // ── decorations ────────────────────────────────────────────────────────────
  //
  // One derivation from `/status`, read by the tree, by the search hits and by
  // the activity bar's badge. Derived rather than stored: a decoration that
  // outlives the status it came from is a lie with a colour on it.
  const deco = useMemo(
    () => (status?.files.length ? decorate(status.files) : NO_DECORATIONS),
    [status],
  );

  // Deleted files are in `/status` and CANNOT be in the tree - the tree lists
  // what is on disk. Anything git calls deleted that the listing does not carry
  // gets grafted in as a tombstone; anything the listing DOES carry (a deletion
  // that has since been recreated, and staged-only deletions of a path that
  // exists again) is left exactly as the listing described it.
  const tombs = useMemo(() => {
    if (!deco.deleted.size) return NO_TOMBS;
    const listed = new Set<string>();
    for (const e of entries) if (e.dir !== true) listed.add(e.path);
    const out = new Set<string>();
    for (const p of deco.deleted) if (!listed.has(p)) out.add(p);
    return out.size ? out : NO_TOMBS;
  }, [deco, entries]);

  const tree = useMemo(() => buildTree(entries, tombs), [entries, tombs]);

  // Filtering switches the rail from a tree to a flat, ranked, capped list. At
  // this scale search IS the navigation: a name match outranks a path-only
  // match, because someone typing "compose" wants compose.yml before every file
  // that happens to live under a folder with "compose" in its name.
  const results: Results | null = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return null;
    const scored: { e: TreeFile; rank: number }[] = [];
    for (const e of entries) {
      if (e.dir === true) continue;
      const lower = e.path.toLowerCase();
      if (!lower.includes(needle)) continue;
      const base = baseName(lower);
      scored.push({ e, rank: base.includes(needle) ? (base.startsWith(needle) ? 0 : 1) : 2 });
    }
    scored.sort((a, b) => a.rank - b.rank || a.e.path.localeCompare(b.e.path));
    return { total: scored.length, shown: scored.slice(0, MAX_RESULTS).map((s) => s.e) };
  }, [entries, q]);

  const fileCount = useMemo(() => entries.filter((e) => e.dir !== true).length, [entries]);

  // Opening a file closes the diff. They share the centre column, and leaving a
  // diff on top of a file the user just asked for is the one behaviour nobody
  // expects. NO dirty guard: opening another file no longer disturbs this one.
  const pick = (p: string) => {
    if (!p) return;
    setDiff(null);
    openOrFocus(root, p);
  };

  // Picking a root moves the EXPLORER, and nothing else. It used to close the
  // open file (and ask first, if it was dirty); with tabs there is no reason for
  // browsing elsewhere to touch what you have open.
  const pickRoot = (r: string) => {
    if (r === root) return;
    setQ('');
    setExpanded(new Set());
    setDiff(null);
    setPickedRepo('');
    setBrowseRoot(r);
  };

  const toggleDir = (p: string) =>
    setExpanded((prev) => {
      const nextSet = new Set(prev);
      nextSet.has(p) ? nextSet.delete(p) : nextSet.add(p);
      return nextSet;
    });

  const collapseAll = () => setExpanded(new Set());

  // Reveal: open every folder above the current file, then scroll its row into
  // view. The scroll waits a frame because the rows it is looking for do not
  // exist until the expansion has rendered - the lazy tree is what makes that
  // true and it is the price of the lazy tree being cheap.
  const reveal = useCallback(() => {
    if (!activePath) return;
    setExpanded((prev) => {
      const nextSet = new Set(prev);
      for (const a of ancestorsOf(activePath)) nextSet.add(a);
      return nextSet;
    });
    setQ('');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const row = treeRef.current?.querySelector(`[data-path="${CSS.escape(activePath)}"]`);
      row?.scrollIntoView({ block: 'center' });
    }));
  }, [activePath]);

  // ── downloads ──────────────────────────────────────────────────────────────
  //
  // Gated here, not by a redirect. :8100 has NO sign-in page: an unauthenticated
  // request to it is a bare 401 with a plain-text body. This page already knows
  // whether there is a session (it loaded the tree), so refusing the click is
  // both cheaper and more truthful than opening a tab that says "Unauthorized".
  const canDownload = !needsAuth && roots.length > 0;

  const download = useCallback((url: string, what: string) => {
    if (!canDownload) return;
    // A tab, never an <a download>. Signed out, <a download> saves the 401 body
    // to disk under a plausible name - a corrupt archive is a worse outcome than
    // a tab showing the refusal. The server always sets Content-Disposition, so
    // the attribute buys nothing even when it works.
    openDownload(url);
    // The outcome is unobservable from here: :8100 is a different origin and
    // sends no CORS headers, so there is no fetch that could read the status.
    // Logging the ATTEMPT is the honest amount of claim to make.
    logCall('download', what, 0, -1, 'opened in a new tab - the outcome is on the sandbox origin');
  }, [canDownload]);

  const downloadFile = useCallback((asAttachment: boolean) => {
    if (!active?.file) return;
    download(rawUrl(active.root, active.file.path, asAttachment), `${active.root}/${active.file.path}`);
  }, [download, active]);

  // The archive caps, enforced BEFORE a tab opens.
  //
  // The service answers 413 with a written-for-a-human message, but that message
  // would land as raw JSON in a new tab, and for the whole `projects` root - 2,771
  // entries against a 2,000 cap - that is the ordinary case, not the exotic one.
  // Everything the cap is about (entry count, total bytes) is already in the tree
  // this page holds, so the refusal can happen here, in words, beside the button
  // that caused it.
  const archive = useCallback((relPath: string, label: string, files: number, bytes: number, format: 'zip' | 'tgz') => {
    if (!canDownload) return;
    if (files === 0) {
      raise({ id: `arch-empty-${relPath}`, tone: 'info', title: 'Nothing to archive',
        detail: `${label} holds no readable files.`, where: `${root}/${relPath}` });
      setTab('problems');
      return;
    }
    if (files > ARCHIVE_MAX_ENTRIES) {
      raise({
        id: `arch-count-${relPath}`, tone: 'warn', title: 'Too many files to archive',
        detail: `${label} holds ${files.toLocaleString()} files; the service refuses anything over `
          + `${ARCHIVE_MAX_ENTRIES.toLocaleString()}. Pick a subfolder - subtrees archive fine.`,
        where: `${root}/${relPath || '.'}`,
      });
      setTab('problems');
      return;
    }
    if (bytes > ARCHIVE_MAX_TOTAL) {
      raise({
        id: `arch-size-${relPath}`, tone: 'warn', title: 'Archive over the size cap',
        detail: `${label} is ${fmtBytes(bytes)}; the service refuses anything over `
          + `${fmtBytes(ARCHIVE_MAX_TOTAL)}. Pick a subfolder.`,
        where: `${root}/${relPath || '.'}`,
      });
      setTab('problems');
      return;
    }
    download(archiveUrl(root, relPath || '.', format), `${root}/${relPath || '.'} (${format})`);
  }, [canDownload, download, raise, root]);

  const archiveNode = useCallback((n: Node) => archive(n.path, n.path || root, n.files, n.bytes, 'zip'), [archive, root]);
  const archiveRoot = useCallback(() => archive('', root, tree.files, tree.bytes, 'zip'), [archive, root, tree]);
  const archiveFile = useCallback((format: 'zip' | 'tgz') => {
    if (!active?.file) return;
    archive(active.file.path, baseName(active.file.path), 1, active.file.size, format);
  }, [archive, active]);

  // ── problems ───────────────────────────────────────────────────────────────
  //
  // Derived, not accumulated, wherever the fact is still true - a truncated tree
  // and a sensitive advisory are STATES, and a state that has stopped being true
  // should leave the list on its own rather than needing to be dismissed.
  const problems = useMemo<Problem[]>(() => {
    const out: Problem[] = [];
    if (truncated) {
      out.push({
        id: 'truncated', tone: 'warn', title: 'This listing is incomplete',
        detail: 'The file service hit its own listing cap, so files below it are missing from the tree. '
          + 'A search that finds nothing here is not proof the file does not exist.',
        where: root,
      });
    }
    // Every OPEN document, not only the active one: a warning about a file you
    // have in a tab does not stop being true because you looked at another tab.
    for (const d of ws.docs) {
      if (!d.file) continue;
      if (d.file.sensitive) {
        out.push({
          id: `sensitive-${d.root}/${d.file.path}`, tone: 'warn', title: 'This file looks sensitive',
          detail: `${d.file.sensitive} - the service flagged it and opened it anyway; it is an advisory, not a refusal.`,
          where: `${d.root}/${d.file.path}`,
        });
      }
      if (d.file.size > ARCHIVE_MAX_MEMBER) {
        out.push({
          id: `member-${d.root}/${d.file.path}`, tone: 'info', title: 'Too large for an archive',
          detail: `${fmtBytes(d.file.size)} is over the ${fmtBytes(ARCHIVE_MAX_MEMBER)} per-file cap, so an archive `
            + 'would list it in SKIPPED.txt rather than include it. Raw download still works.',
          where: `${d.root}/${d.file.path}`,
        });
      }
    }
    for (const c of calls) {
      if (c.ok || c.status === 401) continue;
      out.push({
        id: `call-${c.id}`,
        tone: c.status === 403 ? 'warn' : 'bad',
        title: c.status === 403 ? 'Refused' : c.status ? `${c.op} failed with ${c.status}` : `${c.op} never completed`,
        detail: c.note || 'No detail came back.',
        where: c.detail,
      });
    }
    return [...raised, ...out];
  }, [truncated, ws.docs, calls, raised, root]);

  // ── saving ─────────────────────────────────────────────────────────────────
  //
  // Per document, and reading the document out of `wsRef` rather than closing
  // over it - so the window's Ctrl-S listener does not have to be torn down and
  // rebuilt on every keystroke.
  const save = useCallback(async (id: string) => {
    const d = wsRef.current.docs.find((x) => x.id === id);
    if (!d || !d.file || d.saving) return;
    const f = d.file;
    const draft = d.draft;
    const lang = langFor(f.path, f.lang);
    patchDoc(id, (c) => ({ ...c, saving: true, notice: null }));
    // file.mtime is what this TAB read. Sending it is the whole conflict
    // guarantee - see docs/kb/editor-drafts.md.
    const out = await writeFile(d.root, f.path, draft,
                                d.message.trim() || defaultMessage(f.path, lang),
                                f.mtime);
    patchDoc(id, (c) => ({ ...c, saving: false }));
    switch (out.kind) {
      case 'saved':
        patchDoc(id, (c) => ({
          ...c,
          editing: false,
          // Carry the SERVER's mtime forward, not a locally guessed one. It
          // becomes the baseMtime of the next save from this tab, so it has to
          // be the value the filesystem actually holds - an earlier version used
          // `Date.now() / 1000` here, which would have disagreed with the server
          // and made the very next save 409 against our own write.
          file: c.file
            ? { ...c.file, content: draft, mtime: out.res.mtime, size: out.res.bytes,
                history: out.res.history ?? c.file.history }
            : c.file,
          draft,
          notice: {
            tone: 'ok',
            text: `Saved ${out.res.bytes} bytes to disk${out.res.versioned ? ' - the file is tracked by git' : ''}`,
          },
        }));
        // The file just became (or stopped being) a change. Without this the
        // rail keeps showing the state from before the save, which is the one
        // moment a stale decoration is guaranteed to be wrong.
        setStatusTick((t) => t + 1);
        break;
      case 'conflict':
        // NOT an error. The file moved underneath this tab, and the server
        // refused rather than overwriting - so the only honest thing to do is
        // hand the choice back rather than pick for them.
        patchDoc(id, (c) => ({
          ...c,
          conflict: out.conflict,
          notice: { tone: 'bad', text: 'This file changed on disk since you opened it. Nothing was overwritten.' },
        }));
        break;
      case 'auth':
        patchDoc(id, (c) => ({ ...c, notice: { tone: 'auth' } }));
        break;
      case 'refused':
      case 'too-large':
      case 'error':
        patchDoc(id, (c) => ({ ...c, notice: { tone: 'bad', text: out.message } }));
        raise({
          id: `save-${Date.now()}`, tone: 'bad', title: 'Save refused',
          detail: out.message, where: `${d.root}/${f.path}`,
        });
        break;
    }
  }, [patchDoc, raise]);

  // Resolving a conflict is the user's decision, so each branch does exactly
  // what it says and nothing more.
  const resolveConflict = (choice: 'mine' | 'theirs' | 'dismiss') => {
    if (!active) return;
    const c = active.conflict;
    const id = active.id;
    if (!c) { patchDoc(id, (d) => ({ ...d, conflict: null })); return; }
    if (choice === 'theirs') {
      // Take the disk version. Their bytes AND their mtime, so the next save
      // is based on what is actually there.
      patchDoc(id, (d) => ({
        ...d, conflict: null, draft: c.theirs,
        file: d.file ? { ...d.file, content: c.theirs, mtime: c.currentMtime } : d.file,
        notice: { tone: 'info', text: 'Loaded the version from disk. Your edits were discarded.' },
      }));
      return;
    }
    if (choice === 'mine') {
      // Re-save against the CURRENT mtime, which is a deliberate overwrite
      // rather than an accidental one - the user has been shown both sizes.
      patchDoc(id, (d) => ({
        ...d, conflict: null,
        file: d.file ? { ...d.file, mtime: c.currentMtime } : d.file,
        notice: { tone: 'info', text: 'Press Save again to overwrite the version on disk.' },
      }));
      return;
    }
    patchDoc(id, (d) => ({ ...d, conflict: null, notice: null }));
  };

  // The git MUTATION handlers used to sit here - afterGit, stage, unstage,
  // askDiscard, confirmDiscard, commit and sync, about 170 lines of turning
  // 400/403/503 into sentences. They are gone with the panel's buttons and the
  // service endpoints behind them: git actions belong at a prompt. Nothing on
  // this page can now change a repository, which is why `statusTick` below is
  // only ever bumped by a SAVE or by the panel's refresh button.

  const openDiff = useCallback((c: Change) => {
    if (!c.path) return;
    const target: DiffTarget = { root, path: c.path, staged: c.side === 'staged', untracked: c.untracked };
    setDiffGroup(wsRef.current.focus);
    setDiff((d) => (sameDiff(d, target) ? d : target));
  }, [root]);

  // From the tree - a tombstone row, where the diff is the only readable thing
  // left. The SIDE matters: a deletion that is already staged has an empty
  // working-tree diff, so opening the wrong one would report "nothing to show"
  // about a file that is gone.
  const openDiffPath = useCallback((p: string) => {
    const d = deco.files.get(p);
    const target: DiffTarget = {
      root, path: p, staged: d?.side === 'staged', untracked: d?.letter === 'U' && d.state === 'added',
    };
    setDiffGroup(wsRef.current.focus);
    setDiff((cur) => (sameDiff(cur, target) ? cur : target));
  }, [root, deco]);

  // The activity bar. Clicking the view you are already in collapses the rail,
  // which is what every editor with this strip does and the only way to get the
  // width back without leaving the mouse.
  const pickView = useCallback((v: RailView) => {
    if (v === railView && !panes.cl) { toggle('l'); return; }
    setRailView(v);
    if (panes.cl) toggle('l');
  }, [railView, panes.cl, toggle]);

  const cycleTab = useCallback((by: number) => {
    next((w) => {
      const g = w.groups[w.focus];
      if (!g || g.tabs.length < 2) return w;
      const at = g.active ? g.tabs.indexOf(g.active) : -1;
      const to = g.tabs[((at + by) % g.tabs.length + g.tabs.length) % g.tabs.length];
      return { ...w, groups: w.groups.map((x, i) => (i === w.focus ? { ...x, active: to } : x)) };
    });
  }, [next]);

  // ── the page's own keys ────────────────────────────────────────────────────
  //
  // A window listener rather than CodeMirror bindings, because Save has to work
  // from the commit-message field in the inspector too, and because it is the
  // one shortcut that must fire whether or not the editor chunk loaded.
  //
  // It does not fight the AppShell's global handler: that one ignores keys typed
  // into an input, a textarea OR a contenteditable - the last clause added with
  // this editor, since CodeMirror's writable surface is a contenteditable div
  // and the old tagName-only test did not match it. Without it, `/` opened the
  // command palette and `r` refreshed the dashboard mid-word.
  //
  // Every test comes from keys.ts, which is also what the empty state and the
  // Keys sheet render. That is the whole point of the table: the list of
  // shortcuts and the code that dispatches them cannot drift apart, because
  // there is only one of them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const w = wsRef.current;
      const id = w.groups[w.focus]?.active ?? null;
      if (matches('save', e)) {
        // Only while something is actually being edited. Otherwise Ctrl-S is
        // left to the browser, exactly as it was before this listener existed.
        const d = id ? w.docs.find((x) => x.id === id) : null;
        if (!d?.editing) return;
        e.preventDefault();
        void save(d.id);
        return;
      }
      if (matches('nexttab', e)) { e.preventDefault(); cycleTab(1); return; }
      if (matches('prevtab', e)) { e.preventDefault(); cycleTab(-1); return; }
      if (matches('closetab', e)) {
        e.preventDefault();
        // Through the same guard as the X on the tab. A shortcut that is the
        // cheap way to lose an edit is worse than no shortcut.
        if (id) closeDoc(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, cycleTab, closeDoc]);

  // The browser's own guard, for the one exit this page cannot intercept. ANY
  // dirty document arms it, not only the one on screen - the whole point of
  // tabs is that the others are still there.
  useEffect(() => {
    if (!dirtyDocs.length) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirtyDocs.length]);

  const startEdit = () => {
    if (!active?.file) return;
    const id = active.id;
    patchDoc(id, (d) => ({ ...d, editing: true, draft: d.file?.content ?? '', notice: null }));
    requestAnimationFrame(() => handleFor(id).current?.focus());
  };

  const cancelEdit = () => {
    if (!active) return;
    patchDoc(active.id, (d) => ({ ...d, editing: false, draft: d.file?.content ?? '', notice: null }));
  };

  const retry = () => setReloadTick((t) => t + 1);

  const onFallback = useCallback((why: string) => {
    // Once per session, not once per image: the cause is a response header, so
    // the second occurrence carries no information the first did not.
    raise({
      id: 'corp-fallback', tone: 'info', title: 'Image shown in a frame',
      detail: `${why}. The fix is one word in portal-files - Cross-Origin-Resource-Policy: same-site - `
        + 'which still keeps :8100 a separate origin.',
      where: 'sandbox origin',
    });
  }, [raise]);

  // The inspector's commit-message field, aimed at whichever document is active.
  // Typed as a Dispatch so it is assignable wherever a `useState` setter was.
  const setActiveMessage: React.Dispatch<React.SetStateAction<string>> = useCallback((v) => {
    const w = wsRef.current;
    const id = w.groups[w.focus]?.active;
    if (!id) return;
    patchDoc(id, (d) => ({ ...d, message: typeof v === 'function' ? v(d.message) : v }));
  }, [patchDoc]);

  // Merge the split back into one column, keeping every tab. This is what the
  // divider's Enter/Space does - Resizer's `onToggle` - because "collapse this
  // region" for a region full of open documents has to mean moving them, never
  // hiding them.
  const mergeGroups = useCallback(() => {
    next((w) => {
      if (w.groups.length < 2) return w;
      const [a, b] = w.groups;
      return { ...w, groups: [{ tabs: [...a.tabs, ...b.tabs], active: b.active ?? a.active }], focus: 0 };
    });
  }, [next]);

  const pendingDoc = pending ? ws.docs.find((d) => d.id === pending) ?? null : null;
  const shownDiffGroup = Math.min(diffGroup, groups.length - 1);

  // The shell's CSS variables. Written as a style object on the root, so a drag
  // is one style write and nothing below re-renders while the pointer moves.
  const vars = {
    '--rail-l': `${panes.cl ? 0 : panes.l}px`,
    '--rail-r': `${panes.cr ? 0 : panes.r}px`,
    '--panel-h': `${panes.cp ? 0 : panes.p}px`,
    '--split-w': `${panes.s}px`,
  } as React.CSSProperties;

  return (
    <div className="bothy-files" style={vars} data-collapsed-l={panes.cl} data-collapsed-r={panes.cr}>
      {/* The shell's own header strip. NOT `.page-head` - that is a page title
          above a scrolling document, and this is an application window whose
          chrome has to be as thin as it can be while still carrying the layout
          controls. */}
      <header className="fx-head">
        <div className="fx-head-id">
          <h1 className="fx-head-title">Files</h1>
          <p className="fx-head-sub">
            {needsAuth
              ? 'sign in to browse the box'
              : treeErr
                ? 'the file service is unreachable'
                : <>
                    <b className="tnum">{fileCount.toLocaleString()}</b> in <span className="mono">{root || '…'}</span>
                    {' · '}
                    {/* Save writes to disk and stops. Git is a separate, deliberate
                        act now, and the strip has to say so - it used to say
                        "edits land as git commits", which stopped being true. */}
                    {deco.total > 0
                      ? <><b className="tnum">{deco.total}</b> uncommitted change{deco.total === 1 ? '' : 's'}</>
                      : 'save writes to disk; commit in Source Control'}
                  </>}
          </p>
        </div>
        <div className="fx-head-actions" role="group" aria-label="Layout">
          <Tooltip label={`${panes.cl ? 'Show' : 'Hide'} the explorer`}>
            <button
              type="button"
              className={`fx-hbtn lg ${panes.cl ? '' : 'on'}`}
              aria-pressed={!panes.cl}
              onClick={() => toggle('l')}
              aria-label={`${panes.cl ? 'Show' : 'Hide'} the explorer`}
            >
              <PanelLeft size={16} />
            </button>
          </Tooltip>
          <Tooltip label={`${panes.cp ? 'Show' : 'Hide'} the panel`}>
            <button
              type="button"
              className={`fx-hbtn lg ${panes.cp ? '' : 'on'}`}
              aria-pressed={!panes.cp}
              onClick={() => toggle('p')}
              aria-label={`${panes.cp ? 'Show' : 'Hide'} the panel`}
            >
              <PanelBottom size={16} />
            </button>
          </Tooltip>
          <Tooltip label={`${panes.cr ? 'Show' : 'Hide'} the inspector`} align="end">
            <button
              type="button"
              className={`fx-hbtn lg ${panes.cr ? '' : 'on'}`}
              aria-pressed={!panes.cr}
              onClick={() => toggle('r')}
              aria-label={`${panes.cr ? 'Show' : 'Hide'} the inspector`}
            >
              <PanelRight size={16} />
            </button>
          </Tooltip>
        </div>
      </header>

      {needsAuth ? (
        <div className="fx-gate"><SignInCard what="browse the box" onRetry={retry} /></div>
      ) : treeErr && !entries.length ? (
        <div className="fx-gate">
          <ErrState
            title="Cannot reach the file service"
            body={`/-/api/files did not answer (${treeErr}). Nothing on this page can load until it does.`}
            onRetry={retry}
          />
        </div>
      ) : (
        <div className="fx-grid">
          {/* The activity bar is OUTSIDE the collapse: with the rail hidden it
              is the only thing that can bring it back, and its badge is how a
              change count reaches someone who works with the rail shut. */}
          <ActivityBar
            view={railView}
            onPick={pickView}
            changes={deco.total}
            collapsed={panes.cl}
          />

          {!panes.cl && (
            <div className="fx-col fx-col-l" ref={treeRef}>
              {railView === 'scm' ? (
                <SourceControl
                  root={root}
                  repos={repos}
                  reposErr={reposErr}
                  repoPath={repo?.path ?? ''}
                  onPickRepo={setPickedRepo}
                  status={status}
                  loading={statusLoading}
                  err={statusErr}
                  onRefresh={() => setStatusTick((t) => t + 1)}
                  onOpenDiff={openDiff}
                  openPath={diff?.path ?? null}
                  openStaged={!!diff?.staged}
                />
              ) : (
                <Explorer
                  roots={roots}
                  root={root}
                  tree={tree}
                  results={results}
                  query={q}
                  setQuery={setQ}
                  expanded={expanded}
                  onToggleDir={toggleDir}
                  current={activePath}
                  onPick={pick}
                  onPickRoot={pickRoot}
                  onCollapseAll={collapseAll}
                  onReveal={reveal}
                  onDownloadDir={archiveNode}
                  onDownloadRoot={archiveRoot}
                  loading={treeLoading}
                  error={treeErr}
                  onRetry={retry}
                  truncated={truncated}
                  fileCount={fileCount}
                  filterRef={filterRef}
                  deco={deco}
                  tombs={tombs}
                  onOpenDiff={openDiffPath}
                />
              )}
            </div>
          )}
          {!panes.cl && (
            <Resizer
              axis="x" pane="l" value={panes.l} label="Explorer width"
              onSize={setSize} onNudge={nudge} onReset={reset} onToggle={toggle}
            />
          )}

          <div className="fx-col fx-col-mid">
            {/* One or two groups, side by side, with the SAME resizer the rails
                use between them - pointer capture, arrow keys, role="separator"
                and aria-valuenow all come with it. A second resizer written for
                this would be a second set of those bugs to fix. */}
            <div className="fx-groups" data-split={groups.length > 1}>
              {groups.map((g, gi) => (
                <Fragment key={gi}>
                  {gi === 1 && (
                    <Resizer
                      axis="x" pane="s" value={panes.s} label="Split width"
                      onSize={setSize} onNudge={nudge} onReset={reset}
                      // Enter/Space on the divider merges the split rather than
                      // hiding a group: a hidden group still holding open
                      // documents is a place work can go missing.
                      onToggle={mergeGroups}
                    />
                  )}
                  <Editor
                    group={gi}
                    docs={g.tabs.map((id) => ws.docs.find((d) => d.id === id)).filter((d): d is Doc => !!d)}
                    activeId={g.active}
                    focused={ws.focus === gi}
                    canSplit={groups.length === 1}
                    dragId={dragId}
                    onFocusGroup={() => next((w) => (w.focus === gi ? w : { ...w, focus: gi }))}
                    onSelect={(id) => next((w) => ({
                      ...w, focus: gi,
                      groups: w.groups.map((x, i) => (i === gi ? { ...x, active: id } : x)),
                    }))}
                    onCloseDoc={(id) => closeDoc(id)}
                    onDragStart={setDragId}
                    onDragEnd={() => setDragId(null)}
                    onDropInto={() => { if (dragId) next((w) => moveDoc(w, dragId, gi)); setDragId(null); }}
                    onDropEdge={() => { if (dragId) next((w) => splitOff(w, dragId)); setDragId(null); }}
                    onSplitOff={() => { if (g.active) next((w) => splitOff(w, g.active as string)); }}
                    setDraft={(id, v) => patchDoc(id, (d) => ({ ...d, draft: v }))}
                    setView={(v: View) => { if (g.active) patchDoc(g.active, (d) => ({ ...d, view: v })); }}
                    onEdit={startEdit}
                    onCancel={cancelEdit}
                    onSave={() => { if (g.active) void save(g.active); }}
                    onRetryOpen={(id) => patchDoc(id, (d) => ({ ...d, state: 'new', err: null }))}
                    dismissNotice={() => { if (g.active) patchDoc(g.active, (d) => ({ ...d, notice: null })); }}
                    onResolveConflict={resolveConflict}
                    pending={pendingDoc && g.tabs.includes(pendingDoc.id)
                      ? { id: pendingDoc.id, name: baseName(pendingDoc.path) }
                      : null}
                    resolvePending={resolvePending}
                    diff={gi === shownDiffGroup ? diff : null}
                    diffRes={diffRes}
                    diffLoading={diffLoading}
                    diffErr={diffErr}
                    onDiffSide={(staged) => setDiff((d) => (!d || d.staged === staged ? d : { ...d, staged }))}
                    onCloseDiff={() => setDiff(null)}
                    onDownload={() => downloadFile(true)}
                    onArchive={archiveFile}
                    onReveal={reveal}
                    canDownload={canDownload}
                    onFallback={onFallback}
                    handleFor={handleFor}
                  />
                </Fragment>
              ))}
            </div>

            {!panes.cp && (
              <Resizer
                axis="y" pane="p" value={panes.p} label="Panel height"
                onSize={setSize} onNudge={nudge} onReset={reset} onToggle={toggle}
              />
            )}

            <Panel
              tab={tab}
              setTab={setTab}
              problems={problems}
              calls={calls}
              commits={repoLog}
              collapsed={panes.cp}
              onToggle={() => toggle('p')}
              onClear={() => setCalls([])}
            />
          </div>

          {!panes.cr && (
            <Resizer
              axis="x" pane="r" value={panes.r} label="Inspector width"
              onSize={setSize} onNudge={nudge} onReset={reset} onToggle={toggle}
            />
          )}
          {!panes.cr && (
            <div className="fx-col fx-col-r">
              <Inspector
                root={active?.root ?? root}
                path={active?.path ?? ''}
                file={active?.file ?? null}
                loading={active?.state === 'new' || active?.state === 'loading'}
                history={active?.file ? active.file.history ?? [] : null}
                editing={!!active?.editing}
                message={active?.message ?? ''}
                setMessage={setActiveMessage}
                messagePlaceholder={active?.file
                  ? defaultMessage(active.file.path, langFor(active.file.path, active.file.lang))
                  : ''}
                canDownload={canDownload}
                onDownload={downloadFile}
                onArchive={archiveFile}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
