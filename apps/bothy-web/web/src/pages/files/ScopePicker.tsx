// ── where you are looking ────────────────────────────────────────────────────
//
// One control in the panel header, and it replaces two things that were not
// controls at all (#152):
//
//   · CHOOSING A ROOT MEANT SCROLLING. The roots were section headers
//     interleaved with their own contents, so "go to `projects`" was "scroll
//     past everything in `notes`". They were the only thing in a panel of titles
//     that behaved like a tab strip, and they sat at the panel's edge.
//   · REACHING A FOLDER MEANT FINDING IT. `docs/brand/foundations` was: expand
//     `stacks`, scroll, expand `docs`, expand `brand`, click. There was nowhere
//     to type a path.
//
// It is assembly, not new chrome. `.fx-rootchip` is the group Explorer.tsx
// already draws (including the Lock on a read-only root, which is the only
// warning that every file in it will turn out to have no Edit button) and
// `.fx-hbtn` is the app's icon button. What is new is the path box.
//
// ── THE COMPLETIONS COST NOTHING ────────────────────────────────────────────
//
// They are drawn from the listing the panel ALREADY HOLDS - the same
// `TreeFile[]` the tree is built from - so there is no request, no endpoint and
// no index. The consequence is worth stating rather than hiding: a root that has
// not been opened has no listing, so it offers no completions, and typing a path
// into it still works because Enter does not require one. Suggesting nothing is
// honest; suggesting from a stale copy would not be.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, CornerDownLeft, FolderTree, Lock } from 'lucide-react';
import type { FileRoot, TreeFile } from '../../lib/files';

/** Directories offered at once. The list is a shortcut, not a browser - the tree
 *  below is the browser - so it stops at the point where reading it costs more
 *  than typing one more character. */
const MAX_HINTS = 8;

/** Every directory in a listing, root-relative, deduplicated.
 *
 *  Built from the FILE paths rather than from directory entries, because the
 *  service's `dir` field is the entry's parent path rather than a boolean on the
 *  live service (tree.ts says so at length) - so the paths are the reliable
 *  half, and the ancestors of every file are exactly the set of directories that
 *  contain anything. */
function dirsOf(entries: readonly TreeFile[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.dir === true) continue;
    let at = e.path.indexOf('/');
    while (at !== -1) { out.add(e.path.slice(0, at)); at = e.path.indexOf('/', at + 1); }
  }
  return [...out].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function ScopePicker({ roots, root, scope, entries, onGo }: {
  roots: FileRoot[];
  /** The root being browsed. */
  root: string;
  /** The folder narrowed to, root-relative, '' for the whole root. */
  scope: string;
  /** The open root's listing, for completions. Empty is a legal state - see the
   *  header: a root nobody has opened has nothing to suggest. */
  entries: readonly TreeFile[];
  /** Go there. `dir` is '' for the whole root. */
  onGo: (root: string, dir: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(scope);
  const box = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  // The draft follows the real scope while the popover is SHUT. Reopening on a
  // half-typed path from three folders ago is the popover remembering something
  // the user abandoned; while it is open the draft is theirs.
  useEffect(() => { if (!open) setDraft(scope); }, [open, scope]);
  useEffect(() => { if (open) input.current?.select(); }, [open]);

  // Close on Escape and on a click outside. `pointerdown` rather than `click`,
  // so pressing a control elsewhere on the page does not first have to survive a
  // popover that is still open on top of it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hints = useMemo(() => {
    const all = dirsOf(entries);
    const q = draft.replace(/^\/+/, '').toLowerCase();
    // No query is the TOP LEVEL rather than the first eight of everything: an
    // alphabetical slice of a deep tree offers `.claude`, `.github` and six
    // folders inside `apps`, none of which is where anybody starts.
    const pool = q ? all.filter((d) => d.toLowerCase().includes(q)) : all.filter((d) => !d.includes('/'));
    return pool.slice(0, MAX_HINTS);
  }, [entries, draft]);

  const go = (r: string, dir: string) => {
    onGo(r, dir.replace(/^\/+|\/+$/g, ''));
    setOpen(false);
  };

  const label = scope ? `${root}/${scope}` : root;

  return (
    <div className="rd-scope" ref={box}>
      <button
        type="button"
        className="rd-scope-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        title={`Looking in ${label} - choose a root or a folder`}
      >
        <FolderTree size={13} aria-hidden="true" />
        <span className="rd-scope-lbl mono">{label}</span>
        <ChevronDown size={12} className="rd-scope-chev" aria-hidden="true" />
      </button>

      {open && (
        <div className="rd-scope-pop" role="dialog" aria-label="Where to look">
          {roots.length > 1 && (
            <>
              <p className="rd-scope-h">Root</p>
              <div className="fx-roots" role="group" aria-label="Root">
                {roots.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    className={`fx-rootchip ${r.key === root ? 'on' : ''}`}
                    aria-pressed={r.key === root}
                    // Changing root clears the folder: a path inside `stacks` is
                    // almost never a path inside `notes`, and carrying it over
                    // would scope the new root to a folder it does not have.
                    onClick={() => go(r.key, '')}
                    title={r.readOnly ? `${r.label || r.key} - read-only` : (r.label || r.key)}
                  >
                    {r.key}
                    {r.readOnly && <Lock size={10} className="fx-rootro" aria-label="read-only" />}
                  </button>
                ))}
              </div>
            </>
          )}

          <p className="rd-scope-h">Folder</p>
          <div className="fx-filter rd-scope-path">
            <input
              ref={input}
              type="text"
              value={draft}
              placeholder="docs/guide"
              aria-label={`Folder inside ${root}`}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); go(root, draft); }
                // Stop Escape reaching the page's own handlers, which would
                // close something behind the popover as well.
                if (e.key === 'Escape') e.stopPropagation();
              }}
            />
            <button
              type="button"
              className="rd-scope-go"
              aria-label={`Go to ${draft || root}`}
              onClick={() => go(root, draft)}
            >
              <CornerDownLeft size={13} />
            </button>
          </div>

          {hints.length > 0 && (
            <ul className="rd-scope-hints">
              {hints.map((d) => (
                <li key={d}>
                  <button type="button" className="mono" onClick={() => go(root, d)}>{d}</button>
                </li>
              ))}
            </ul>
          )}
          {/* Said out loud rather than left as an empty list, because "no
              suggestions" and "this root has not been listed yet" look identical
              and only one of them means the path is wrong. */}
          {!hints.length && (
            <p className="rd-scope-none">
              {entries.length
                ? <>No folder in <span className="mono">{root}</span> matches that. Enter still goes there.</>
                : <>Nothing listed for <span className="mono">{root}</span> yet - type a folder and press Enter.</>}
            </p>
          )}

          {scope && (
            <button type="button" className="btn ghost sm rd-scope-all" onClick={() => go(root, '')}>
              Show all of {root}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
