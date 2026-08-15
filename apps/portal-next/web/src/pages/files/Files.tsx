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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PanelBottom, PanelLeft, PanelRight } from 'lucide-react';
import {
  ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_MEMBER, ARCHIVE_MAX_TOTAL,
  archiveUrl, fileHistory, fmtBytes, gitAction, gitDiff, gitStatus, isAuthError, langFor,
  listRepos, listRoots, listTree, logCall,
  looksBinary, onApiCall, openDownload, rawUrl, readFile, writeFile,
  type ApiCall, type Commit, type DiffResult, type FileRead, type FileRoot, type GitOutcome,
  type RepoInfo, type StatusResult, type TreeFile, type WriteConflict,
} from '../../lib/files';
import { ErrState } from '../../components/states';
import { Tooltip } from '../../components/Tooltip';
import { ActivityBar, type RailView } from './ActivityBar';
import { Explorer, MAX_RESULTS, type Results } from './Explorer';
import { Editor, type Notice, type View } from './Editor';
import type { CodeHandle } from './CodeSurface';
import type { DiffTarget } from './Diff';
import { Inspector } from './Inspector';
import { Panel, type PanelTab, type Problem } from './Panel';
import { Resizer } from './Resizer';
import { SignInCard } from './SignInCard';
import { SourceControl, type DiscardAsk, type ScmNotice } from './SourceControl';
import { decorate, groupChanges, NO_DECORATIONS, type Change } from './gitdeco';
import { usePanes } from './panes';
import { ancestorsOf, baseName, buildTree, defaultMessage, kindOf, type Node } from './tree';

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

export function Files() {
  const [params, setParams] = useSearchParams();
  const root = params.get('root') || '';
  const path = params.get('path') || '';

  const { panes, setSize, nudge, reset, toggle } = usePanes();

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
  const [view, setView] = useState<View>('preview');
  // Set when a file or root is picked while there are unsaved edits: the switch
  // waits for an answer instead of silently throwing the work away.
  const [pending, setPending] = useState<{ root: string; path: string } | null>(null);
  // Set when the server refuses a stale save. Holds BOTH versions so the user
  // can choose; never auto-resolved, because picking for them is exactly the
  // silent data loss this whole mechanism exists to prevent.
  const [conflict, setConflict] = useState<WriteConflict | null>(null);

  // Resolving a conflict is the user's decision, so each branch does exactly
  // what it says and nothing more.
  const resolveConflict = (choice: 'mine' | 'theirs' | 'dismiss') => {
    const c = conflict;
    setConflict(null);
    if (!c || !file) return;
    if (choice === 'theirs') {
      // Take the disk version. Their bytes AND their mtime, so the next save
      // is based on what is actually there.
      setFile({ ...file, content: c.theirs, mtime: c.currentMtime });
      setDraft(c.theirs);
      setNotice({ tone: 'info', text: 'Loaded the version from disk. Your edits were discarded.' });
      return;
    }
    if (choice === 'mine') {
      // Re-save against the CURRENT mtime, which is a deliberate overwrite
      // rather than an accidental one - the user has been shown both sizes.
      setFile({ ...file, mtime: c.currentMtime });
      setNotice({ tone: 'info', text: 'Press Save again to overwrite the version on disk.' });
      return;
    }
    setNotice(null);
  };

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
  const [scmMessage, setScmMessage] = useState('');
  const [scmNotice, setScmNotice] = useState<ScmNotice | null>(null);
  const [ask, setAsk] = useState<DiscardAsk | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [busyRepo, setBusyRepo] = useState(false);
  // Re-read the OPEN FILE after git changed it underneath us. Guarded at the
  // call site: it must never fire while an edit is in progress, because the
  // read effect resets the draft.
  const [fileTick, setFileTick] = useState(0);

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

  // An imperative handle rather than a DOM node: the text surface is a
  // CodeMirror instance whose editable element is a contenteditable div the
  // page never touches directly, and the plain textarea fallback publishes the
  // same two methods so this side does not care which one is mounted.
  const editorRef = useRef<CodeHandle | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  const dirty = editing && !!file && draft !== file.content;

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
    return (path ? repoForPath(repos, path) : null) ?? repos[0] ?? null;
  }, [repos, pickedRepo, path, repoForPath]);

  // What every git call is scoped to. A path inside the repo is enough - the
  // service derives the repository from it, which is why no client ever names a
  // directory as a repo.
  const scope = repo ? repo.path : (path || '');

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

  // The open file. Every mode/draft/notice reset lives here, keyed on the URL,
  // so there is exactly one place that decides what "a different file" means.
  useEffect(() => {
    setEditing(false);
    setNotice(null);
    setNewSha(null);
    setView('preview');
    setFileAuth(false);
    if (!root || !path) { setFile(null); setFileErr(null); return; }
    const ac = new AbortController();
    setFileLoading(true);
    readFile(root, path, ac.signal)
      .then((f) => {
        setFile(f);
        setFileErr(null);
        setDraft(f.content ?? '');
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
    // `fileTick` re-reads the same file after git changed it on disk. It is
    // only ever bumped while nothing is being edited - see afterGit - because
    // everything above resets the draft.
  }, [root, path, fileTick]);

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

  const go = useCallback((nextRoot: string, nextPath: string) => {
    const next = new URLSearchParams();
    next.set('root', nextRoot);
    if (nextPath) next.set('path', nextPath);
    setParams(next);
  }, [setParams]);

  const pick = (p: string) => {
    if (dirty) { setPending({ root, path: p }); return; }
    // Opening a file closes the diff. They share the centre column, and leaving
    // a diff on top of a file the user just asked for is the one behaviour
    // nobody expects.
    setDiff(null);
    go(root, p);
  };
  const pickRoot = (r: string) => {
    if (r === root) return;
    if (dirty) { setPending({ root: r, path: '' }); return; }
    setQ('');
    setExpanded(new Set());
    setDiff(null);
    setPickedRepo('');
    setScmNotice(null);
    setAsk(null);
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

  const collapseAll = () => setExpanded(new Set());

  // Reveal: open every folder above the current file, then scroll its row into
  // view. The scroll waits a frame because the rows it is looking for do not
  // exist until the expansion has rendered - the lazy tree is what makes that
  // true and it is the price of the lazy tree being cheap.
  const reveal = useCallback(() => {
    if (!path) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const a of ancestorsOf(path)) next.add(a);
      return next;
    });
    setQ('');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const row = treeRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`);
      row?.scrollIntoView({ block: 'center' });
    }));
  }, [path]);

  // `binary` is the backend's answer when it sends one; the local sniff is the
  // fallback for a response that does not carry the field.
  const binary = !!file && (file.binary === true || looksBinary(file.content ?? ''));
  const kind = useMemo(() => kindOf(path || (file?.path ?? ''), binary), [path, file, binary]);
  const editable = !!file && file.writable && kind === 'text';
  const lang = file ? langFor(file.path, file.lang) : '';

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
    if (!file) return;
    download(rawUrl(root, file.path, asAttachment), `${root}/${file.path}`);
  }, [download, file, root]);

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
    if (!file) return;
    archive(file.path, baseName(file.path), 1, file.size, format);
  }, [archive, file]);

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
    if (file?.sensitive) {
      out.push({
        id: `sensitive-${file.path}`, tone: 'warn', title: 'This file looks sensitive',
        detail: `${file.sensitive} - the service flagged it and opened it anyway; it is an advisory, not a refusal.`,
        where: `${root}/${file.path}`,
      });
    }
    if (file && file.size > ARCHIVE_MAX_MEMBER) {
      out.push({
        id: `member-${file.path}`, tone: 'info', title: 'Too large for an archive',
        detail: `${fmtBytes(file.size)} is over the ${fmtBytes(ARCHIVE_MAX_MEMBER)} per-file cap, so an archive `
          + 'would list it in SKIPPED.txt rather than include it. Raw download still works.',
        where: `${root}/${file.path}`,
      });
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
  }, [truncated, file, calls, raised, root]);

  // ── saving ─────────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!file || saving) return;
    setSaving(true);
    setNotice(null);
    // file.mtime is what this tab READ. Sending it is the whole conflict
    // guarantee - see docs/kb/editor-drafts.md.
    const out = await writeFile(root, file.path, draft,
                                message.trim() || defaultMessage(file.path, lang),
                                file.mtime);
    setSaving(false);
    switch (out.kind) {
      case 'saved':
        setEditing(false);
        setNewSha(null);
        // Carry the SERVER's mtime forward, not a locally guessed one. It
        // becomes the baseMtime of the next save from this tab, so it has to be
        // the value the filesystem actually holds - an earlier version used
        // `Date.now() / 1000` here, which would have disagreed with the server
        // and made the very next save 409 against our own write.
        setFile({
          ...file,
          content: draft,
          mtime: out.res.mtime,
          size: out.res.bytes,
          history: out.res.history ?? file.history,
        });
        setNotice({
          tone: 'ok',
          text: `Saved ${out.res.bytes} bytes to disk${out.res.versioned ? ' - commit it in Source Control' : ''}`,
        });
        // The file just became (or stopped being) a change. Without this the
        // rail keeps showing the state from before the save, which is the one
        // moment a stale decoration is guaranteed to be wrong.
        setStatusTick((t) => t + 1);
        break;
      case 'conflict':
        // NOT an error. The file moved underneath this tab, and the server
        // refused rather than overwriting - so the only honest thing to do is
        // hand the choice back rather than pick for them.
        setConflict(out.conflict);
        setNotice({
          tone: 'bad',
          text: 'This file changed on disk since you opened it. Nothing was overwritten.',
        });
        break;
      case 'auth':
        setNotice({ tone: 'auth' });
        break;
      case 'refused':
      case 'too-large':
      case 'error':
        setNotice({ tone: 'bad', text: out.message });
        raise({
          id: `save-${Date.now()}`, tone: 'bad', title: 'Save refused',
          detail: out.message, where: `${root}/${file.path}`,
        });
        break;
    }
  }, [file, root, draft, message, saving, lang, raise]);

  // ── git ────────────────────────────────────────────────────────────────────
  //
  // Every mutation lands here, and every outcome is turned into a SENTENCE
  // rather than a status code. That is the whole job of this block: the service
  // answers 400, 403 and 503 for things that are not faults - nothing is
  // staged, this session has editor but not operator, no push credential is
  // mounted on this box - and each of them has to read as the fact it is.
  const afterGit = useCallback((out: GitOutcome, verb: string, onOk: (ok: Extract<GitOutcome, { kind: 'ok' }>['res']) => void) => {
    switch (out.kind) {
      case 'ok':
        // Every mutation returns the fresh status, so the rail is correct
        // without a second round trip.
        setStatus({ root: out.res.root, repo: out.res.repo, branch: out.res.branch, files: out.res.files });
        onOk(out.res);
        // Re-read the open file only when nothing is being edited: the read
        // effect resets the draft, and a discard that also threw away an
        // unsaved edit would be the exact failure this page exists to prevent.
        if (!editing) setFileTick((t) => t + 1);
        // Any open diff is now about the previous state of the repo.
        setStatusTick((t) => t + 1);
        break;
      case 'auth':
        setScmNotice({ tone: 'auth', text: `Signing in is needed to ${verb}. Nothing was changed.` });
        break;
      case 'role':
        // 403. For push and pull this is the role tier, which is a fact about
        // the session rather than a failure - the routes require `operator`
        // deliberately, because publishing is not editing.
        setScmNotice({
          tone: 'info',
          text: verb === 'push' || verb === 'pull'
            ? `${verb === 'push' ? 'Pushing' : 'Pulling'} needs the operator role - this session can change files here but not publish them.`
            : `The service refused to ${verb}.`,
          detail: out.message,
        });
        break;
      case 'refused':
        // The service declining on purpose, with a sentence written for a
        // human. Shown verbatim; anything else would be a paraphrase that can
        // drift from what the server actually enforces.
        setScmNotice({ tone: 'warn', text: out.message, detail: out.remote ? `remote: ${out.remote}` : out.hint });
        break;
      case 'unset':
        // 503, and on this box it is the EXPECTED answer: most repos here have
        // no push credential mounted. "Not set up" and "broken" must not look
        // the same, so this is info and says what would make it work.
        setScmNotice({
          tone: 'info',
          text: `${verb === 'push' ? 'Push' : 'Sync'} is not set up on this box yet - ${out.message}.`,
          detail: out.hint,
        });
        break;
      case 'error':
        setScmNotice({ tone: 'bad', text: out.message });
        break;
    }
  }, [editing]);

  const stage = useCallback(async (p: string) => {
    setScmNotice(null);
    setAsk(null);
    setBusyPath(p);
    const out = await gitAction('stage', { root, path: p });
    setBusyPath(null);
    afterGit(out, 'stage', () => setScmNotice({ tone: 'ok', text: `Staged ${baseName(p)}.` }));
  }, [root, afterGit]);

  const unstage = useCallback(async (p: string) => {
    setScmNotice(null);
    setAsk(null);
    setBusyPath(p);
    const out = await gitAction('unstage', { root, path: p });
    setBusyPath(null);
    afterGit(out, 'unstage', () => setScmNotice({ tone: 'ok', text: `Unstaged ${baseName(p)}. The change is still on disk.` }));
  }, [root, afterGit]);

  // ── discard, the only irreversible thing on this page ──────────────────────
  //
  // `git restore --worktree` throws away content that was NEVER IN THE OBJECT
  // STORE, so no part of git can bring it back. Save no longer commits, which
  // means the working tree is routinely the only copy an edit has ever had.
  //
  // Three guards, in this order:
  //
  //   1. refused outright while the editor holds unsaved changes for that file.
  //      Discarding then would destroy the disk copy while a DIFFERENT
  //      uncommitted version sits in a tab - two losses from one click.
  //   2. a confirmation that quotes the server's own refusal. The sentence is
  //      obtained by ASKING: the first call carries `confirm: false`, which the
  //      service answers with 400 and its reason. That is deliberately not
  //      "send it and see" - an explicit false can never be read as consent by
  //      any future version of the service, so the probe cannot become the
  //      destructive call by accident.
  //   3. only ever per-file. The service refuses a whole-repo discard even with
  //      confirm, and this never offers one.
  const askDiscard = useCallback(async (p: string) => {
    setScmNotice(null);
    if (dirty && file && file.path === p) {
      setScmNotice({
        tone: 'warn',
        text: `${baseName(p)} has unsaved changes in the editor, so discard is refused.`,
        detail: 'Discard would throw away the version on disk - irreversibly - while your tab still holds a '
          + 'different one. Save it or cancel the edit first, then decide.',
      });
      return;
    }
    setBusyPath(p);
    const out = await gitAction('discard', { root, path: p, confirm: false });
    setBusyPath(null);
    if (out.kind === 'refused') { setAsk({ path: p, serverSaid: out.message }); return; }
    if (out.kind === 'ok') {
      // Should be unreachable: the service requires confirm: true. If it ever
      // stops, that is a change in the safety contract and it gets said out
      // loud rather than passed off as a success.
      afterGit(out, 'discard', () => setScmNotice({
        tone: 'bad',
        text: `${baseName(p)} was discarded WITHOUT a confirmation - the service no longer requires one.`,
        detail: 'That is a change in the file service, not in this page. It should be looked at.',
      }));
      return;
    }
    afterGit(out, 'discard', () => {});
  }, [root, dirty, file, afterGit]);

  const confirmDiscard = useCallback(async () => {
    const a = ask;
    if (!a) return;
    setAsk(null);
    setBusyPath(a.path);
    const out = await gitAction('discard', { root, path: a.path, confirm: true });
    setBusyPath(null);
    afterGit(out, 'discard', () => setScmNotice({
      tone: 'ok',
      text: `Discarded ${baseName(a.path)}. It matches the last commit again.`,
    }));
  }, [ask, root, afterGit]);

  const commit = useCallback(async () => {
    setScmNotice(null);
    setAsk(null);
    // Counted BEFORE the call, and it has to be: the commit response carries no
    // list of committed files. The handler builds one and then loses it - it
    // merges `**status(...)` over its own `files` key, and status has a `files`
    // key too. See the note on GitOk.
    const staged = groupChanges(status?.files ?? []).staged.length;
    setBusyRepo(true);
    const out = await gitAction('commit', { root, path: scope, message: scmMessage });
    setBusyRepo(false);
    afterGit(out, 'commit', (res) => {
      setScmMessage('');
      setNewSha(res.sha ?? null);
      setScmNotice({
        tone: 'ok',
        text: `Committed ${res.sha} - ${staged} file${staged === 1 ? '' : 's'}.`,
        detail: res.message,
      });
    });
  }, [root, scope, scmMessage, status, afterGit]);

  const sync = useCallback(async (verb: 'pull' | 'push') => {
    setScmNotice(null);
    setAsk(null);
    setBusyRepo(true);
    const out = await gitAction(verb, { root, path: scope });
    setBusyRepo(false);
    afterGit(out, verb, (res) => setScmNotice({
      tone: 'ok',
      text: `${verb === 'pull' ? 'Pulled' : 'Pushed'} ${status?.repo ?? root}.`,
      detail: res.output,
    }));
  }, [root, scope, afterGit, status]);

  const openDiff = useCallback((c: Change) => {
    if (!c.path) return;
    setDiff({ root, path: c.path, staged: c.side === 'staged', untracked: c.untracked });
  }, [root]);

  // From the tree - a tombstone row, where the diff is the only readable thing
  // left. The SIDE matters: a deletion that is already staged has an empty
  // working-tree diff, so opening the wrong one would report "nothing to show"
  // about a file that is gone.
  const openDiffPath = useCallback((p: string) => {
    const d = deco.files.get(p);
    setDiff({ root, path: p, staged: d?.side === 'staged', untracked: d?.letter === 'U' && d.state === 'added' });
  }, [root, deco]);

  // The activity bar. Clicking the view you are already in collapses the rail,
  // which is what every editor with this strip does and the only way to get the
  // width back without leaving the mouse.
  const pickView = useCallback((v: RailView) => {
    if (v === railView && !panes.cl) { toggle('l'); return; }
    setRailView(v);
    if (panes.cl) toggle('l');
  }, [railView, panes.cl, toggle]);

  // Ctrl/Cmd-S while editing. A window listener rather than a CodeMirror
  // binding, because it has to work from the commit-message field in the
  // inspector too, and because it is the one shortcut that must fire whether or
  // not the editor chunk loaded.
  //
  // It does not fight the AppShell's global handler: that one ignores keys typed
  // into an input, a textarea OR a contenteditable - the last clause added with
  // this editor, since CodeMirror's writable surface is a contenteditable div
  // and the old tagName-only test did not match it. Without it, `/` opened the
  // command palette and `r` refreshed the dashboard mid-word.
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

  // The shell's CSS variables. Written as a style object on the root, so a drag
  // is one style write and nothing below re-renders while the pointer moves.
  const vars = {
    '--rail-l': `${panes.cl ? 0 : panes.l}px`,
    '--rail-r': `${panes.cr ? 0 : panes.r}px`,
    '--panel-h': `${panes.cp ? 0 : panes.p}px`,
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
                  readOnly={!!roots.find((r) => r.key === root)?.readOnly}
                  repos={repos}
                  reposErr={reposErr}
                  repoPath={repo?.path ?? ''}
                  onPickRepo={setPickedRepo}
                  status={status}
                  loading={statusLoading}
                  err={statusErr}
                  onRefresh={() => setStatusTick((t) => t + 1)}
                  message={scmMessage}
                  setMessage={setScmMessage}
                  onCommit={() => void commit()}
                  onSync={(v) => void sync(v)}
                  onStage={(p) => void stage(p)}
                  onUnstage={(p) => void unstage(p)}
                  onDiscard={(p) => void askDiscard(p)}
                  busyPath={busyPath}
                  busyRepo={busyRepo}
                  notice={scmNotice}
                  dismissNotice={() => setScmNotice(null)}
                  ask={ask}
                  onConfirmDiscard={() => void confirmDiscard()}
                  onCancelDiscard={() => setAsk(null)}
                  onOpenDiff={openDiff}
                  openPath={diff?.path ?? null}
                  openStaged={!!diff?.staged}
                  // Exactly one file can hold unsaved editor state, and discard
                  // has to know which.
                  dirtyPath={dirty ? file?.path ?? null : null}
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
                  current={path}
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
            <Editor
              root={root}
              path={path}
              file={file}
              kind={kind}
              lang={lang}
              loading={fileLoading}
              err={fileErr}
              auth={fileAuth}
              onRetryOpen={() => go(root, path)}
              view={view}
              setView={setView}
              editing={editing}
              draft={draft}
              setDraft={setDraft}
              dirty={dirty}
              saving={saving}
              editable={editable}
              onEdit={startEdit}
              onCancel={cancelEdit}
              onSave={() => void save()}
              notice={notice}
              conflict={conflict}
              onResolveConflict={resolveConflict}
              diff={diff}
              diffRes={diffRes}
              diffLoading={diffLoading}
              diffErr={diffErr}
              onDiffSide={(staged) => setDiff((d) => (d ? { ...d, staged } : d))}
              onCloseDiff={() => setDiff(null)}
              dismissNotice={() => setNotice(null)}
              pending={pending !== null}
              resolvePending={resolvePending}
              onDownload={() => downloadFile(true)}
              canDownload={canDownload}
              onFallback={onFallback}
              editorRef={editorRef}
            />

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
                root={root}
                path={path}
                file={file}
                loading={fileLoading}
                history={file ? file.history ?? [] : null}
                newSha={newSha}
                editing={editing}
                message={message}
                setMessage={setMessage}
                messagePlaceholder={file ? defaultMessage(file.path, lang) : ''}
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
