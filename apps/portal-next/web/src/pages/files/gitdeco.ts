// ── git state, as the tree and the Source Control panel both need it ─────────
//
// One model, two consumers. The explorer needs "what colour is this row, and
// what colour is the folder it is closed inside"; Source Control needs "which
// rows go in Staged and which go in Changes". Both are the same fact read from
// the same `/status` response, so they are derived once, here, rather than
// twice with a chance of disagreeing.
//
// THE CODE IS LOSSY AND THAT SHAPES EVERYTHING BELOW. git's porcelain code is
// two columns - index then work tree - and the service sends it STRIPPED, so
// " M" and "M " both arrive as "M" and the column is gone. What survives is:
//
//   · a two-character code means BOTH columns are non-space: "MM" is a file
//     that is staged AND modified again since, and it belongs in both groups;
//   · a one-character code means exactly one column, and `staged` says which;
//   · "??" is untracked, which is a work-tree-only state by definition.
//
// Reconstructing it that way is exact, not a guess, and it is the difference
// between a file showing up in one group and a file showing up in the group it
// is actually in.

import type { StatusFile } from '../../lib/files';

/** The four things a change can BE, and the only four colours it can have.
 *  Mapped onto the existing status tokens - up/warn/down - and nothing else;
 *  a fourth palette for git would put five meanings on three hues. */
export type GitState = 'added' | 'modified' | 'deleted' | 'conflict';

export interface Change {
  /** Root-relative. NULL is a real value: a changed file the explorer may not
   *  open, counted by the service and deliberately not named. Never link it. */
  path: string | null;
  /** The raw stripped code, kept so a row can show what git actually said. */
  code: string;
  side: 'staged' | 'worktree';
  /** The single letter shown in the rail. M/A/D/U/R/C - VS Code's alphabet. */
  letter: string;
  state: GitState;
  untracked: boolean;
  /** The word for the letter, for a title and for a screen reader. */
  label: string;
}

// Letter -> meaning. The letters are git's, so this is a translation table and
// not a taxonomy: A added, M modified, D deleted, R renamed, C copied, T type
// changed, U unmerged.
const LETTER: Record<string, { state: GitState; label: string }> = {
  A: { state: 'added', label: 'added' },
  M: { state: 'modified', label: 'modified' },
  T: { state: 'modified', label: 'type changed' },
  R: { state: 'modified', label: 'renamed' },
  C: { state: 'added', label: 'copied' },
  D: { state: 'deleted', label: 'deleted' },
  U: { state: 'conflict', label: 'unmerged - resolve the conflict' },
};

function change(path: string | null, code: string, side: Change['side'], letter: string, untracked = false): Change {
  const known = LETTER[letter] ?? { state: 'modified' as GitState, label: 'changed' };
  return {
    path,
    code,
    side,
    letter,
    state: untracked ? 'added' : known.state,
    untracked,
    label: untracked ? 'untracked' : known.label,
  };
}

/**
 * One status row into the one or two changes it really is.
 *
 * A conflicted entry ("UU", "AA", "DD", "AU", "UD"...) is a WORK TREE row and
 * only ever one row: both of its columns describe the same unresolved merge,
 * and listing it under Staged as well would invite someone to unstage half of a
 * conflict.
 */
export function splitChange(f: StatusFile): Change[] {
  const code = f.code;
  if (code === '??' || f.untracked) return [change(f.path, code, 'worktree', 'U', true)];
  if (code.includes('U') || code === 'AA' || code === 'DD') {
    return [change(f.path, code, 'worktree', 'U')];
  }
  if (code.length >= 2) {
    // Both columns present: staged as code[0], still-dirty as code[1].
    return [change(f.path, code, 'staged', code[0]), change(f.path, code, 'worktree', code[1])];
  }
  return [change(f.path, code, f.staged ? 'staged' : 'worktree', code)];
}

export interface Groups {
  staged: Change[];
  worktree: Change[];
  /** Changed files the explorer may not open, counted so the panel can say the
   *  groups are short without pretending to know their names. */
  hidden: number;
}

export function groupChanges(files: StatusFile[]): Groups {
  const staged: Change[] = [];
  const worktree: Change[] = [];
  let hidden = 0;
  for (const f of files) {
    for (const c of splitChange(f)) {
      if (c.path === null) hidden++;
      (c.side === 'staged' ? staged : worktree).push(c);
    }
  }
  const by = (a: Change, b: Change) => (a.path ?? '').localeCompare(b.path ?? '');
  staged.sort(by);
  worktree.sort(by);
  return { staged, worktree, hidden };
}

// ── decorations ──────────────────────────────────────────────────────────────

export interface Deco {
  state: GitState;
  letter: string;
  label: string;
  staged: boolean;
  /** Which side the shown letter came from. The tombstone rows need it: a
   *  deletion that is already staged has an EMPTY working-tree diff, so opening
   *  the wrong side would say "nothing to show" about a file that is gone. */
  side: 'staged' | 'worktree';
  /** For a directory: how many changed files are at or below it. 0 for a file. */
  count: number;
}

// Which state wins when a folder holds several. A closed folder gets ONE colour,
// so the order is the order of "what would you want to be told first":
//
//   conflict  something in here is unmerged and nothing else matters until it is
//   deleted   something in here is gone - the loudest fact about a tree
//   modified  the ordinary case
//   added     the quietest; new files are the least surprising thing to find
//
// The count badge beside it is what actually carries the volume; the colour only
// has to answer "is there anything in here, and how alarming is it".
const RANK: Record<GitState, number> = { conflict: 3, deleted: 2, modified: 1, added: 0 };

export interface Decorations {
  /** Files, by root-relative path. */
  files: Map<string, Deco>;
  /** Directories, by root-relative path, with a descendant count. */
  dirs: Map<string, Deco>;
  /** Deleted paths - the ones that are in /status and CANNOT be in the tree. */
  deleted: Set<string>;
  /** How many changed files exist at all, hidden ones included. The activity
   *  bar's badge, so it is honest about what it is counting. */
  total: number;
}

export const NO_DECORATIONS: Decorations = {
  files: new Map(), dirs: new Map(), deleted: new Set(), total: 0,
};

/**
 * Every path git mentioned, decorated, plus the colour that has to travel up to
 * the collapsed folders above it.
 *
 * A file that is BOTH staged and modified again gets the work-tree state, which
 * is the one that is still true of the bytes on disk - the same choice VS Code
 * makes, and the useful one: the staged half is already recorded, the unstaged
 * half is what you would lose.
 */
export function decorate(files: StatusFile[]): Decorations {
  const out: Decorations = { files: new Map(), dirs: new Map(), deleted: new Set(), total: 0 };
  for (const f of files) {
    out.total++;
    const parts = splitChange(f);
    const path = f.path;
    if (path === null) continue;
    // Work tree first, so a "MM" row is decorated by the half that is not yet
    // recorded anywhere.
    const chosen = parts.find((c) => c.side === 'worktree') ?? parts[0];
    out.files.set(path, {
      state: chosen.state,
      letter: chosen.letter,
      label: chosen.label,
      staged: parts.some((c) => c.side === 'staged'),
      side: chosen.side,
      count: 0,
    });
    if (parts.some((c) => c.state === 'deleted')) out.deleted.add(path);

    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
      const dir = path.slice(0, at);
      const prev = out.dirs.get(dir);
      if (!prev) {
        out.dirs.set(dir, {
          state: chosen.state, letter: '', label: '', staged: false, side: chosen.side, count: 1,
        });
      } else {
        prev.count++;
        if (RANK[chosen.state] > RANK[prev.state]) prev.state = chosen.state;
      }
    }
  }
  return out;
}

/** The CSS tone for a state. Only ever these three - `--st-up`, `--st-warn`,
 *  `--st-down` - because those are the colours this app has for state. */
export function toneFor(state: GitState): 'up' | 'warn' | 'down' {
  if (state === 'added') return 'up';
  if (state === 'modified') return 'warn';
  return 'down';
}
