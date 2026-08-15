// ── the unified diff, in the centre column ───────────────────────────────────
//
// A diff is not a file, so it does not go through the editor's surfaces: it has
// no language to highlight (the +/- column would break every rule set at the
// start of a line), it must never be editable, and its meaning is carried by
// exactly one thing - which side of the change a line is on.
//
// So it is rendered as rows with a state class each, and the ONLY colours are
// the status tokens: `--st-up` for what arrives, `--st-down` for what leaves.
// That is the same green/rose this app uses for up/down everywhere else, which
// is the point - a fourth palette for diffs would be a fourth thing to learn.
//
// A `+` or `-` glyph sits in its own column beside the tint, so the two sides
// are still distinguishable when the colours are not.

import { useMemo } from 'react';
import { FileDiff, GitCommitVertical } from 'lucide-react';
import type { DiffResult } from '../../lib/files';
import { EmptyState, ErrState, Skeleton } from '../../components/states';

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

interface Line { kind: LineKind; text: string }

// The classification is positional and that is all a unified diff gives you.
// Order matters: `+++`/`---` are FILE HEADERS and are tested before the single
// `+`/`-`, or every diff would open with a spurious added and removed line.
function parse(diff: string): Line[] {
  const out: Line[] = [];
  for (const text of diff.split('\n')) {
    if (text.startsWith('@@')) out.push({ kind: 'hunk', text });
    else if (text.startsWith('+++') || text.startsWith('---')
             || text.startsWith('diff ') || text.startsWith('index ')
             || text.startsWith('new file') || text.startsWith('deleted file')
             || text.startsWith('similarity ') || text.startsWith('rename ')
             || text.startsWith('old mode') || text.startsWith('new mode')
             || text.startsWith('Binary files') || text.startsWith('\\')) {
      out.push({ kind: 'meta', text });
    } else if (text.startsWith('+')) out.push({ kind: 'add', text });
    else if (text.startsWith('-')) out.push({ kind: 'del', text });
    else out.push({ kind: 'ctx', text });
  }
  // git's output ends with a newline, so the split leaves one empty tail row.
  if (out.length && out[out.length - 1].text === '') out.pop();
  return out;
}

export interface DiffTarget {
  root: string;
  path: string;
  staged: boolean;
  /** Set for an untracked file, so the empty case can say WHY it is empty
   *  rather than implying the file matches HEAD. */
  untracked?: boolean;
}

export function DiffView({ target, res, loading, err }: {
  target: DiffTarget;
  res: DiffResult | null;
  loading: boolean;
  err: string | null;
}) {
  const lines = useMemo(() => (res?.diff ? parse(res.diff) : []), [res]);

  const counts = useMemo(() => {
    let add = 0; let del = 0;
    for (const l of lines) { if (l.kind === 'add') add++; else if (l.kind === 'del') del++; }
    return { add, del };
  }, [lines]);

  if (loading) return <div className="fx-pad"><Skeleton variant="table" /></div>;
  if (err) {
    return (
      <div className="fx-pad">
        <ErrState title="Could not read that diff" body={`${target.root}/${target.path} - ${err}`} />
      </div>
    );
  }
  if (res && res.diff === null) {
    return (
      <div className="fx-pad">
        <EmptyState
          message="No diff for this path"
          hint={res.reason || 'The service did not say why.'}
        />
      </div>
    );
  }
  if (!res || res.empty || lines.length === 0) {
    return (
      <div className="fx-pad">
        <EmptyState
          message="Nothing to show on this side"
          hint={target.untracked
            // The honest explanation, because "empty" here does NOT mean "no
            // changes": git has no previous version of an untracked file, so
            // `git diff` prints nothing however new the file is.
            ? 'This file is untracked, so git has no earlier version to compare it against. '
              + 'Stage it and the staged side will show the whole file as new.'
            : target.staged
              ? 'Nothing is staged for this file - its changes are all still in the working tree.'
              : 'The working tree matches the index. Any change to this file is already staged.'}
        />
      </div>
    );
  }

  return (
    <div className="fx-diff scroll-shade" tabIndex={0}>
      <div className="fx-diff-sum">
        <FileDiff size={13} aria-hidden="true" />
        <span className="mono">{target.path}</span>
        <span className="fx-diff-side">
          {target.staged
            ? <><GitCommitVertical size={11} aria-hidden="true" /> staged, against HEAD</>
            : 'working tree, against the index'}
        </span>
        <span className="fx-diff-counts tnum">
          <span className="add">+{counts.add}</span>
          <span className="del">-{counts.del}</span>
        </span>
      </div>
      <pre className="fx-diff-body">
        {lines.map((l, i) => (
          // The index IS the identity here: a diff is an immutable snapshot
          // rendered once, and two identical lines are genuinely
          // interchangeable rows.
          // eslint-disable-next-line react/no-array-index-key
          <code className={`fx-diff-line k-${l.kind}`} key={i}>{l.text || ' '}</code>
        ))}
      </pre>
    </div>
  );
}
