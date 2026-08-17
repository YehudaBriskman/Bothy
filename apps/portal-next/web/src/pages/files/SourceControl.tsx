// ── the left rail, as Changes ────────────────────────────────────────────────
//
// The view is `scm` in code and "Changes" on screen. See ActivityBar.tsx for why
// it stopped being called Source Control: the top nav now has a section called
// Control, and two unrelated things a click apart cannot share that word.
//
// The same column the explorer lives in, answering a different question: not
// "which file" but WHAT HAS CHANGED, AND WHAT DOES THAT CHANGE LOOK LIKE.
//
// THIS PANEL IS A VIEWER. It has no stage, no unstage, no discard, no commit
// box, no pull and no push - they were removed rather than disabled, because a
// control that a config flip could bring back is a control you have to keep
// reasoning about. Git actions belong in a terminal, and the page says so once,
// in one line, where the commit box used to be. When this product grows an
// in-browser terminal they come back there, next to every other git verb, not
// as five buttons that reimplement six of them.
//
// What that leaves is deliberate rather than residual:
//
// Two groups, because git has two: STAGED CHANGES is what the next commit will
// contain, CHANGES is what it will not. That distinction is the whole reason
// staging exists and the panel would be lying if it merged them - so a file that
// is both staged and modified again appears in both, which is exactly what it
// is. It matters to a reader even when nothing here can move a file between
// them: `git commit` in a terminal will still commit exactly the top group.
//
// A NULL PATH IS A REAL ROW. `/status` counts changed files the explorer may not
// open - a denied secret - and does not name them. They are shown, and never
// linked. Dropping them would make the counts disagree with git for no visible
// reason.
//
// REFRESH STAYS, and it is now the panel's only button that is not a file. It
// did not exist merely to follow a mutation this page fired; with the mutations
// gone it matters MORE, because every change this panel can show is now made
// somewhere else - a terminal, an editor, a script - and re-reading is the only
// way to see one arrive.
//
// The repository NAME and the repository PICKER are one thing, on one row: when
// there is more than one repo in scope the name IS the picker; when there is
// one, it is just the name.

import { useState } from 'react';
import { ChevronRight, GitBranch, Lock, RefreshCw, TerminalSquare } from 'lucide-react';
import { relDate, type RepoInfo, type StatusResult } from '../../lib/files';
import { Tooltip } from '../../components/Tooltip';
import { FileIcon } from './icons';
import { baseName, dirName, tailPath } from './tree';
import { groupChanges, toneFor, type Change } from './gitdeco';

function Row({ c, onOpenDiff, open }: {
  c: Change;
  onOpenDiff: (c: Change) => void;
  open: boolean;
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
    </li>
  );
}

/**
 * One group: a heading that collapses, a count, and its files.
 *
 * The heading is a plain button and nothing else. It used to be a ROW - a
 * toggle plus a stage-all/unstage-all button revealed on hover - and when the
 * bulk action went, the row went with it rather than staying behind as an empty
 * flex container with one child in it.
 */
function Group({ title, changes, onOpenDiff, openPath, openStaged }: {
  title: string;
  changes: Change[];
  onOpenDiff: (c: Change) => void;
  openPath: string | null;
  openStaged: boolean;
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
              onOpenDiff={onOpenDiff}
              open={c.path !== null && c.path === openPath && staged === openStaged}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function SourceControl({
  root, repos, reposErr, repoPath, onPickRepo, status, loading, err, onRefresh,
  onOpenDiff, openPath, openStaged,
}: {
  root: string;
  repos: RepoInfo[] | null;
  reposErr: string | null;
  repoPath: string;
  onPickRepo: (p: string) => void;
  status: StatusResult | null;
  loading: boolean;
  err: string | null;
  onRefresh: () => void;
  onOpenDiff: (c: Change) => void;
  openPath: string | null;
  openStaged: boolean;
}) {
  const groups = groupChanges(status?.files ?? []);
  const repo = repos?.find((r) => r.path === repoPath) ?? null;
  const total = groups.staged.length + groups.worktree.length;

  return (
    <aside className="fx-rail fx-rail-l" aria-label="Changes">
      {/* One button, and it re-reads. There is no `readOnly` branch anywhere in
          this panel any more: with nothing here that writes, a read-only mount
          and a writable one look and behave identically, so saying which was
          which would be explaining a restriction that no longer restricts
          anything on this page. */}
      <div className="fx-rail-h">
        <span className="fx-rail-title">Changes</span>
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
            <span className="fx-scm-branch">
              <GitBranch size={13} aria-hidden="true" />
              <span className="mono">{status.branch || '(detached)'}</span>
            </span>
          ) : (
            <span className="fx-scm-branch dim">
              <GitBranch size={13} aria-hidden="true" />
              <span>{loading ? 'looking…' : 'no repository in scope'}</span>
            </span>
          )}
          {/* The name and the picker are the same fact. With one repo in scope
              there is nothing to pick, so it is a label; with several, the
              label is the control - which is what a <select> already looks
              like, and is one row shorter than printing the name and then
              offering a menu of names underneath it. */}
          {repos && repos.length > 1 ? (
            <label className="fx-scm-repopick">
              <span className="sr-only">Repository</span>
              <select value={repoPath} onChange={(e) => onPickRepo(e.target.value)}>
                {repos.map((r) => (
                  <option key={r.path} value={r.path}>
                    {r.name}{r.dirty ? ` · ${r.dirty} changed` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : status?.repo ? (
            <span className="fx-scm-reponame mono" title={`${root}/${repoPath === '.' ? '' : repoPath}`}>
              {status.repo}
            </span>
          ) : null}
        </div>

        {repo && (
          <p className="fx-scm-last" title={new Date(repo.lastDate).toLocaleString()}>
            <span className="mono">{repo.lastSha}</span> {repo.lastSubject}
            <span className="fx-scm-when">{relDate(repo.lastDate)}</span>
          </p>
        )}

        {/* ── where the verbs went ──────────────────────────────────────────
            One line, exactly where the commit box was, so someone who came
            here for Commit reads it on the way to where the button used to be.
            It is a statement of where the tool is, not an apology or a
            disabled control: nothing on this page needs permission, so nothing
            here has to say "you cannot". */}
        <p className="fx-scm-where">
          <TerminalSquare size={12} aria-hidden="true" />
          <span>
            Viewing only — stage, commit and push with{' '}
            <span className="mono">git</span> in a terminal on the box.
          </span>
        </p>

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
              onOpenDiff={onOpenDiff}
              openPath={openPath}
              openStaged={openStaged}
            />
            <Group
              title="Changes"
              changes={groups.worktree}
              onOpenDiff={onOpenDiff}
              openPath={openPath}
              openStaged={openStaged}
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
