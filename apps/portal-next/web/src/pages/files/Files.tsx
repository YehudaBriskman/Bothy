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
  archiveUrl, fileHistory, fmtBytes, isAuthError, langFor, listRoots, listTree, logCall,
  looksBinary, onApiCall, openDownload, rawUrl, readFile, writeFile,
  type ApiCall, type Commit, type FileRead, type FileRoot, type TreeFile,
} from '../../lib/files';
import { ErrState } from '../../components/states';
import { Tooltip } from '../../components/Tooltip';
import { Explorer, MAX_RESULTS, type Results } from './Explorer';
import { Editor, type Notice, type View } from './Editor';
import type { CodeHandle } from './CodeSurface';
import { Inspector } from './Inspector';
import { Panel, type PanelTab, type Problem } from './Panel';
import { Resizer } from './Resizer';
import { SignInCard } from './SignInCard';
import { usePanes } from './panes';
import { ancestorsOf, baseName, buildTree, defaultMessage, kindOf, type Node } from './tree';

import './shell.css';
import './explorer.css';
import './editor.css';
import './inspector.css';
import './panel.css';

const MAX_CALLS = 200;

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
        raise({
          id: `save-${Date.now()}`, tone: 'bad', title: 'Save refused',
          detail: out.message, where: `${root}/${file.path}`,
        });
        break;
    }
  }, [file, root, draft, message, saving, lang, raise]);

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
                : <><b className="tnum">{fileCount.toLocaleString()}</b> in <span className="mono">{root || '…'}</span> · edits land as git commits</>}
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
          {!panes.cl && (
            <div className="fx-col fx-col-l" ref={treeRef}>
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
              />
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
