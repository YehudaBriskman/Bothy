// ── the left rail, as Source Control ─────────────────────────────────────────
//
// The same column the explorer lives in, answering a different question: not
// "which file" but "what have I changed, and what am I going to do about it".
//
// Two groups, because git has two: STAGED CHANGES is what the next commit will
// contain, CHANGES is what it will not. That distinction is the whole reason
// staging exists and the panel would be lying if it merged them - so a file that
// is both staged and modified again appears in both, which is exactly what it
// is.
//
// THREE THINGS HERE ARE NOT ORNAMENTAL:
//
//  1. DISCARD IS IRREVERSIBLE and it is the only control on this page that can
//     destroy work with no way back. `git restore --worktree` throws away
//     content that was never in the object store, and since save stopped
//     committing, the working tree is routinely the ONLY copy of an edit. So it
//     is confirmed, it is refused outright while the editor holds unsaved
//     changes for that file, and it is never offered for a whole repository.
//     The confirmation quotes THE SERVER'S OWN refusal - see Files.tsx, which
//     fires the unconfirmed call first precisely so the sentence shown is the
//     one the service wrote and cannot drift from it.
//
//  2. A NULL PATH IS A REAL ROW. `/status` counts changed files the explorer may
//     not open - a denied secret - and does not name them. They are shown,
//     disabled, and never linked. Dropping them would make the counts disagree
//     with git for no visible reason.
//
//  3. 503 FROM PUSH IS THE ORDINARY ANSWER on this box: most repos have no push
//     credential mounted. It reads as "not set up", because dressing an expected
//     state as a failure is how people learn to ignore failures.

import { useState } from 'react';
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, ChevronRight, CircleCheck,
  GitBranch, Info, Loader, Lock, LogIn, Minus, Plus, RefreshCw, Undo2, X,
} from 'lucide-react';
import {
  relDate, signInUrl,
  type RepoInfo, type StatusResult,
} from '../../lib/files';
import { Tooltip } from '../../components/Tooltip';
import { FileIcon } from './icons';
import { baseName, dirName, tailPath } from './tree';
import { groupChanges, toneFor, type Change } from './gitdeco';

/** What the panel is told about the last action. Tones are the app's, so this
 *  reuses `.fx-note` and introduces no new colours. */
export interface ScmNotice {
  tone: 'ok' | 'info' | 'warn' | 'bad' | 'auth';
  text: string;
  /** The server's second sentence - a hint, a remote URL, git's own output. */
  detail?: string;
}

/** A discard the user has asked for and the server has already refused once. */
export interface DiscardAsk {
  path: string;
  /** The service's refusal, verbatim. */
  serverSaid: string;
}

function Row({ c, onOpenDiff, open, busy, onStage, onUnstage, onDiscard, dirty, frozen }: {
  c: Change;
  onOpenDiff: (c: Change) => void;
  open: boolean;
  busy: boolean;
  /** The root is read-only: every mutation would 403 at the edge of the
   *  service, so none of them is offered. */
  frozen: boolean;
  onStage: (p: string) => void;
  onUnstage: (p: string) => void;
  onDiscard: (p: string) => void;
  /** This file has unsaved editor state, so discard must not be offered. */
  dirty: boolean;
}) {
  const tone = toneFor(c.state);

  if (c.path === null) {
    return (
      <li className="fx-scm-li">
        <span className="fx-scm-row denied" title={`git reports a change here (${c.label}), but the explorer may not open the file - so the service counts it without naming it.`}>
          <Lock size={13} className="fx-ico t-denied" aria-hidden="true" />
          <span className="fx-scm-text">
            <span className="fx-name">a change you may not open</span>
            <span className="fx-scm-dir">counted, deliberately not named</span>
          </span>
          <span className={`fx-scm-code t-${tone}`} aria-hidden="true">{c.letter}</span>
        </span>
      </li>
    );
  }

  const path = c.path;
  const dir = dirName(path).replace(/\/$/, '');
  return (
    <li className="fx-scm-li">
      <button
        type="button"
        className={`fx-scm-row ${open ? 'on' : ''}`}
        onClick={() => onOpenDiff(c)}
        title={`${path} - ${c.label} (${c.code}). Opens the diff.`}
      >
        <FileIcon name={path} />
        <span className="fx-scm-text">
          <span className="fx-name">{baseName(path)}</span>
          {dir && <span className="fx-scm-dir">{tailPath(dir)}</span>}
        </span>
        <span className={`fx-scm-code t-${tone}`} aria-label={c.label}>{c.letter}</span>
      </button>
      <span className="fx-scm-acts">
        {busy && <Loader size={12} className="spin fx-scm-busy" aria-label="working" />}
        {c.side === 'worktree' ? (
          <>
            {/* Discard, and everything that makes it survivable. Untracked is
                its own case: `git restore --worktree` cannot remove a file git
                has never seen, so offering it would be offering a 400. */}
            <Tooltip label={
              frozen
                ? 'This root is mounted read-only - nothing here can be changed.'
                : c.untracked
                ? 'Discard cannot remove an untracked file - git has no version to restore. Delete it from a terminal.'
                : dirty
                  ? 'This file has unsaved changes in the editor. Save or cancel them first - discard is irreversible.'
                  : 'Discard - irreversible'
            }>
              <button
                type="button"
                className="fx-scm-act"
                disabled={busy || frozen || c.untracked || dirty}
                onClick={() => onDiscard(path)}
                aria-label={`Discard changes to ${path}`}
              >
                <Undo2 size={13} aria-hidden="true" />
              </button>
            </Tooltip>
            <Tooltip label="Stage" align="end">
              <button
                type="button"
                className="fx-scm-act"
                disabled={busy || frozen}
                onClick={() => onStage(path)}
                aria-label={`Stage ${path}`}
              >
                <Plus size={13} aria-hidden="true" />
              </button>
            </Tooltip>
          </>
        ) : (
          <Tooltip label="Unstage" align="end">
            <button
              type="button"
              className="fx-scm-act"
              disabled={busy || frozen}
              onClick={() => onUnstage(path)}
              aria-label={`Unstage ${path}`}
            >
              <Minus size={13} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </span>
    </li>
  );
}

function Group({ title, changes, ...rest }: {
  title: string;
  changes: Change[];
  frozen: boolean;
  onOpenDiff: (c: Change) => void;
  openPath: string | null;
  openStaged: boolean;
  busyPath: string | null;
  onStage: (p: string) => void;
  onUnstage: (p: string) => void;
  onDiscard: (p: string) => void;
  dirtyPath: string | null;
}) {
  const [open, setOpen] = useState(true);
  if (!changes.length) return null;
  const staged = changes[0].side === 'staged';
  return (
    <section className="fx-scm-group">
      <button
        type="button"
        className="fx-scm-grouph"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={12} className={`fx-chev ${open ? 'open' : ''}`} aria-hidden="true" />
        <span>{title}</span>
        <span className="fx-scm-count tnum">{changes.length}</span>
      </button>
      {open && (
        <ul className="fx-list">
          {changes.map((c) => (
            <Row
              key={`${c.side}:${c.path ?? 'hidden'}:${c.code}`}
              c={c}
              onOpenDiff={rest.onOpenDiff}
              open={c.path !== null && c.path === rest.openPath && staged === rest.openStaged}
              busy={rest.busyPath === c.path}
              onStage={rest.onStage}
              onUnstage={rest.onUnstage}
              onDiscard={rest.onDiscard}
              frozen={rest.frozen}
              dirty={c.path !== null && c.path === rest.dirtyPath}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function SourceControl({
  root, readOnly, repos, reposErr, repoPath, onPickRepo, status, loading, err, onRefresh,
  message, setMessage, onCommit, onSync, onStage, onUnstage, onDiscard,
  busyPath, busyRepo, notice, dismissNotice, ask, onConfirmDiscard, onCancelDiscard,
  onOpenDiff, openPath, openStaged, dirtyPath,
}: {
  root: string;
  /** The root is mounted READ-ONLY in the service, so every git verb - pull
   *  included - is refused with a 403 before it reaches git. Offering the
   *  buttons anyway would be offering four ways to be told no. */
  readOnly: boolean;
  repos: RepoInfo[] | null;
  reposErr: string | null;
  repoPath: string;
  onPickRepo: (p: string) => void;
  status: StatusResult | null;
  loading: boolean;
  err: string | null;
  onRefresh: () => void;
  message: string;
  setMessage: (v: string) => void;
  onCommit: () => void;
  onSync: (verb: 'pull' | 'push') => void;
  onStage: (p: string) => void;
  onUnstage: (p: string) => void;
  onDiscard: (p: string) => void;
  busyPath: string | null;
  busyRepo: boolean;
  notice: ScmNotice | null;
  dismissNotice: () => void;
  ask: DiscardAsk | null;
  onConfirmDiscard: () => void;
  onCancelDiscard: () => void;
  onOpenDiff: (c: Change) => void;
  openPath: string | null;
  openStaged: boolean;
  dirtyPath: string | null;
}) {
  const groups = groupChanges(status?.files ?? []);
  const repo = repos?.find((r) => r.path === repoPath) ?? null;
  const total = groups.staged.length + groups.worktree.length;

  return (
    <aside className="fx-rail fx-rail-l" aria-label="Source Control">
      <div className="fx-rail-h">
        <span className="fx-rail-title">Source Control</span>
        <span className="fx-rail-sub tnum">{total || ''}</span>
        <Tooltip label="Re-read git status" align="end">
          <button
            type="button"
            className="fx-hbtn"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh the git status"
          >
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
          </button>
        </Tooltip>
      </div>

      <div className="fx-scm scroll-shade">
        {/* ── which repository ──────────────────────────────────────────────
            A root is not a repository. `home` and `projects` hold several and
            are not repos themselves, so the panel has to say which one it is
            talking about before anything below it means anything. */}
        <div className="fx-scm-repo">
          {status?.repo ? (
            <>
              <span className="fx-scm-branch">
                <GitBranch size={13} aria-hidden="true" />
                <span className="mono">{status.branch || '(detached)'}</span>
              </span>
              <span className="fx-scm-reponame mono" title={`${root}/${repoPath === '.' ? '' : repoPath}`}>
                {status.repo}
              </span>
            </>
          ) : (
            <span className="fx-scm-branch dim">
              <GitBranch size={13} aria-hidden="true" />
              <span>{loading ? 'looking…' : 'no repository in scope'}</span>
            </span>
          )}
        </div>

        {repos && repos.length > 1 && (
          <label className="fx-scm-pick">
            <span className="sr-only">Repository</span>
            <select value={repoPath} onChange={(e) => onPickRepo(e.target.value)}>
              {repos.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name}{r.dirty ? ` · ${r.dirty} changed` : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {readOnly && (
          <p className="fx-scm-ro">
            <Lock size={12} aria-hidden="true" />
            <span>
              <b className="mono">{root}</b> is mounted read-only in the file service, so staging,
              committing and syncing are all refused here. The history and the diffs still work.
            </span>
          </p>
        )}

        {repo && (
          <p className="fx-scm-last" title={new Date(repo.lastDate).toLocaleString()}>
            <span className="mono">{repo.lastSha}</span> {repo.lastSubject}
            <span className="fx-scm-when">{relDate(repo.lastDate)}</span>
          </p>
        )}

        {/* ── the outcome of the last action ────────────────────────────────
            A live region rather than a toast: this product has no toast layer,
            and half of what lands here (503 "no credential", 403 "needs
            operator") is something you want to still be able to read. */}
        {notice && (
          <div className={`fx-note ${notice.tone} fx-scm-note`} role="status">
            {notice.tone === 'ok' && <CircleCheck size={14} aria-hidden="true" />}
            {notice.tone === 'info' && <Info size={14} aria-hidden="true" />}
            {notice.tone === 'warn' && <AlertTriangle size={14} aria-hidden="true" />}
            {notice.tone === 'bad' && <AlertTriangle size={14} aria-hidden="true" />}
            {notice.tone === 'auth' && <LogIn size={14} aria-hidden="true" />}
            <span className="fx-scm-note-body">
              {notice.text}
              {notice.detail && <span className="fx-scm-note-detail">{notice.detail}</span>}
              {notice.tone === 'auth' && (
                <a className="btn sm" href={signInUrl()}>Sign in</a>
              )}
            </span>
            <button type="button" className="icon-btn sm" aria-label="Dismiss" onClick={dismissNotice}>
              <X size={13} />
            </button>
          </div>
        )}

        {/* ── the confirmation ──────────────────────────────────────────────
            Not a window.confirm: this needs three sentences and a quotation
            from the server, and the browser's dialog can carry neither the
            wording nor the tone. Rendered where the action was asked for. */}
        {ask && (
          <div className="fx-scm-confirm" role="alertdialog" aria-label="Confirm discard">
            <div className="fx-scm-confirm-h">
              <AlertTriangle size={15} aria-hidden="true" />
              <strong>Discard {baseName(ask.path)}?</strong>
            </div>
            <p>
              This throws away the changes on disk and <b>nothing can bring them back</b>.
              Git cannot help: the content was never committed, so it is not in the object
              store. Since saving no longer commits, the working tree is often the only
              copy an edit has ever had.
            </p>
            <p className="fx-scm-confirm-said">
              The service refused the first attempt and said: “{ask.serverSaid}”
            </p>
            <div className="fx-scm-confirm-acts">
              <button type="button" className="btn ghost sm" onClick={onCancelDiscard}>Keep the changes</button>
              <button type="button" className="btn sm fx-danger" onClick={onConfirmDiscard}>
                <Undo2 size={13} aria-hidden="true" /> Discard permanently
              </button>
            </div>
          </div>
        )}

        {/* ── commit ────────────────────────────────────────────────────────
            The button is NOT disabled when there is nothing staged or no
            message. Both are refused by the service with a sentence written for
            a human ("nothing is staged"), and being told why is more use than a
            grey button that explains nothing. */}
        <div className="fx-scm-commit">
          <label className="fx-scm-msg">
            <span className="sr-only">Commit message</span>
            <textarea
              value={message}
              rows={2}
              placeholder={groups.staged.length
                ? `Message (commits ${groups.staged.length} staged file${groups.staged.length === 1 ? '' : 's'})`
                : 'Message (nothing is staged yet)'}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit(); }
              }}
            />
          </label>
          <button
            type="button"
            className="btn primary sm fx-scm-commitbtn"
            onClick={onCommit}
            disabled={busyRepo || readOnly || !status?.repo}
          >
            {busyRepo ? <Loader size={13} className="spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
            Commit
          </button>
        </div>

        {/* ── sync ──────────────────────────────────────────────────────────
            A tier above everything else on this page: these are the only two
            actions that leave the box, and the route requires `operator` rather
            than `editor`. A 403 here is a fact about the session, not a fault. */}
        <div className="fx-scm-sync">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => onSync('pull')}
            disabled={busyRepo || readOnly || !status?.repo}
          >
            <ArrowDownToLine size={13} aria-hidden="true" /> Pull
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => onSync('push')}
            disabled={busyRepo || readOnly || !status?.repo}
          >
            <ArrowUpFromLine size={13} aria-hidden="true" /> Push
          </button>
          {/* A requirement, not a verdict. "needs the operator role" read like a
              refusal aimed at the current session - which would be wrong for
              anyone who has it, and this session does. Phrased as what the
              buttons require, which is true regardless of who is looking. */}
          <span className="fx-scm-synchint">Pull and Push require the operator role</span>
        </div>

        {/* ── the groups ────────────────────────────────────────────────── */}
        {err ? (
          <div className="fx-msg">
            <p>{err}</p>
            <button type="button" className="btn ghost" onClick={onRefresh}>Retry</button>
          </div>
        ) : loading && !status ? (
          <div className="fx-skel" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => <span className="skel" key={i} />)}
          </div>
        ) : !status?.repo ? (
          <div className="fx-msg">
            <p>
              {reposErr
                ? reposErr
                : repos && repos.length === 0
                  ? `Nothing under ${root} is a git repository, as far as two levels down.`
                  : 'Open a file inside a repository, or pick one above.'}
            </p>
          </div>
        ) : total === 0 ? (
          <div className="fx-msg">
            <p>No changes. The working tree matches <span className="mono">{status.branch}</span>.</p>
          </div>
        ) : (
          <>
            <Group
              title="Staged Changes"
              changes={groups.staged}
              frozen={readOnly}
              onOpenDiff={onOpenDiff}
              openPath={openPath}
              openStaged={openStaged}
              busyPath={busyPath}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
              dirtyPath={dirtyPath}
            />
            <Group
              title="Changes"
              changes={groups.worktree}
              frozen={readOnly}
              onOpenDiff={onOpenDiff}
              openPath={openPath}
              openStaged={openStaged}
              busyPath={busyPath}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
              dirtyPath={dirtyPath}
            />
          </>
        )}
      </div>

      <footer className="fx-rail-f">
        <span className="mono">{root}</span>
        <span className="fx-rail-f-sep" aria-hidden="true">·</span>
        <span className="tnum">{total} change{total === 1 ? '' : 's'}</span>
        {groups.hidden > 0 && (
          <Tooltip label="Changed files the explorer may not open. Counted so these totals still agree with git." align="end">
            <span className="tag warn">{groups.hidden} hidden</span>
          </Tooltip>
        )}
      </footer>
    </aside>
  );
}
