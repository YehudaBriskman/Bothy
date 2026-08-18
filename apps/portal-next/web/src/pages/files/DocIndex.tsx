// ── the document index ───────────────────────────────────────────────────────
//
// The reader's side panel, and the part of docs/plans/reading-first.md §3 that
// says most plainly what it must NOT be: "the Explorer with different CSS".
//
// Three differences, and each one is a decision rather than a style:
//
//   · IT SHOWS TITLES. `tailnet-troubleshooting.md` is "Tailnet
//     troubleshooting" (titles.ts), with the filename underneath in mono for
//     anyone who came looking for a path. The Explorer shows the filename
//     because the Explorer is a view of a filesystem; this is a view of a
//     library.
//   · IT IS PROSE FIRST. Markdown, rst and txt, grouped by folder. Everything
//     else - 117 code files and 42 configs in the stacks root alone - is behind
//     one "All files" toggle. The reader is NOT lied to about what is there;
//     the order is by what the page is for, and the count of what is hidden is
//     printed next to the switch that reveals it.
//   · IT IS FLAT INSIDE A ROOT. Folder, then its documents, then the next
//     folder - no chevrons, no expand state, no lazy children. That works here
//     and does not work in the Explorer for one measurable reason: prose is
//     ~84 files across the two documentation roots, and a tree exists to make
//     3,500 files navigable. Turning on "All files" is the case where that
//     stops being true, so that is exactly where the row cap lives.
//
// A ROOT IS LOADED WHEN IT IS OPENED, not on mount. /tree is capped at 4,000
// entries per root (portal-files/app.py MAX_LISTING) and there are four roots,
// so listing all of them up front is up to 16,000 entries of JSON to render a
// panel whose first screen is eighteen notes. The root the URL names is open on
// arrival; the others are one click.

import { useEffect, useMemo, useRef } from 'react';
import { ChevronRight, FileText, Layers, Lock } from 'lucide-react';
import { fmtBytes, type FileRoot, type TreeFile } from '../../lib/files';
import { FileIcon } from './icons';
import { folderLabel, isProse, stemOf, titleOf } from './titles';
import { tailPath } from './tree';

/** What one root's listing is doing. Held by the Reader, one per root. */
export interface RootTree {
  entries: TreeFile[];
  truncated: boolean;
  loading: boolean;
  err: string | null;
}

/** Rows drawn for one root before the list gives up and says so.
 *
 *  Only reachable with "All files" on: prose tops out at 69 files in the largest
 *  root. It is the same refusal the Explorer's search results make at 250 and
 *  the tree listing makes at 4,000 - a list that silently stops is how someone
 *  concludes a file is not there. */
const MAX_ROWS = 400;

interface Folder { dir: string; files: TreeFile[] }

/** Lowercase, and every separator run collapsed to one space - so `a-b_c.md`
 *  and "A b c" compare equal. Used only to decide whether a row's title and its
 *  filename are the same string wearing different punctuation. */
const fold = (s: string) => s.toLowerCase().replace(/[-_.\s]+/g, ' ').trim();

/** Group a root's files by their directory, keeping the service's path order.
 *  `entries` arrives sorted by path, so directories come out in path order and
 *  the files inside one are already alphabetical - no second sort, and the
 *  ordering matches the tree the Explorer draws from the same bytes. */
function foldersOf(entries: TreeFile[], prose: boolean): { folders: Folder[]; total: number } {
  const at = new Map<string, Folder>();
  const folders: Folder[] = [];
  let total = 0;
  for (const e of entries) {
    if (e.dir === true) continue;
    if (prose && !isProse(e.path)) continue;
    total++;
    if (total > MAX_ROWS) continue;
    const cut = e.path.lastIndexOf('/');
    const dir = cut === -1 ? '' : e.path.slice(0, cut);
    let f = at.get(dir);
    if (!f) { f = { dir, files: [] }; at.set(dir, f); folders.push(f); }
    f.files.push(e);
  }
  return { folders, total };
}

function DocRow({ entry, root, current, onOpen }: {
  entry: TreeFile; root: string; current: string; onOpen: (root: string, path: string) => void;
}) {
  const on = entry.path === current;
  const denied = entry.readable === false;
  const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
  const prose = isProse(entry.path);
  // A title is a CLAIM about what the file is for, and it is only honest for
  // prose. `compose.yml` prettified to "Compose" would be inventing a document.
  const label = prose ? titleOf(entry.path) : name;
  // The filename under the title, and only when the title is not already the
  // filename. Compared with the separators FOLDED, which is the whole point:
  // "Tailnet performance" and `tailnet-performance.md` are the same string with
  // different punctuation, and printing both put a second line under most rows
  // that carried no information at all. What survives the fold is a title the
  // filename genuinely does not spell - a dated incident note, mostly - and
  // those are exactly the rows where the filename is worth showing.
  const sub = prose && fold(stemOf(name)) !== fold(label) ? name : '';

  return (
    <li className="rd-li">
      <button
        type="button"
        className={`rd-doc${on ? ' on' : ''}${denied ? ' denied' : ''}`}
        // Both halves, because `home` mirrors the other roots: the same
        // relative path exists in two open sections, and a lookup on the path
        // alone would scroll to whichever rendered first.
        data-root={root}
        data-path={entry.path}
        aria-current={on ? 'true' : undefined}
        aria-disabled={denied || undefined}
        disabled={denied}
        onClick={() => onOpen(root, entry.path)}
        title={denied ? `${entry.path} - this session may not read it` : `${root}/${entry.path} · ${fmtBytes(entry.size)}`}
      >
        {denied
          ? <Lock size={13} className="rd-doc-ico" aria-hidden="true" />
          : prose
            ? <FileText size={13} className="rd-doc-ico" aria-hidden="true" />
            : <FileIcon name={name} size={13} />}
        <span className="rd-doc-text">
          <span className="rd-doc-title">{label}</span>
          {sub && <span className="rd-doc-name">{sub}</span>}
        </span>
      </button>
    </li>
  );
}

function RootSection({
  root, tree, open, onToggle, allFiles, current, currentRoot, onOpen, onRetry, onScope,
}: {
  root: FileRoot;
  tree: RootTree | undefined;
  open: boolean;
  onToggle: () => void;
  allFiles: boolean;
  current: string;
  currentRoot: string;
  onOpen: (root: string, path: string) => void;
  onRetry: (root: string) => void;
  /** Narrow the listing to one folder, the way `cd` narrows what `ls` shows.
   *  '' is the whole root again. */
  onScope: (root: string, dir: string) => void;
}) {
  const entries = tree?.entries ?? [];
  const { folders, total } = useMemo(
    () => foldersOf(entries, !allFiles),
    [entries, allFiles],
  );
  // What the toggle would ADD, stated on the toggle's own row rather than left
  // for the reader to infer from a number that changed.
  const hidden = useMemo(
    () => (allFiles ? 0 : entries.filter((e) => e.dir !== true && !isProse(e.path)).length),
    [entries, allFiles],
  );

  return (
    <section className="rd-root" aria-label={root.label || root.key}>
      <h3 className="rd-root-h">
        <button type="button" className="rd-root-btn" aria-expanded={open} onClick={onToggle}>
          <ChevronRight size={12} className={`rd-chev${open ? ' open' : ''}`} aria-hidden="true" />
          <span className="rd-root-name mono">{root.key}</span>
          {root.readOnly && <Lock size={10} className="rd-root-ro" aria-label="read-only" />}
          {open && !tree?.loading && (
            <span className="rd-root-n tnum">{total > MAX_ROWS ? `${MAX_ROWS}+` : total}</span>
          )}
        </button>
      </h3>

      {open && (
        tree?.loading ? (
          <div className="rd-skel" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => <span className="skel" key={i} />)}
          </div>
        ) : tree?.err ? (
          <div className="rd-msg">
            <p>{tree.err}</p>
            <button type="button" className="btn ghost sm" onClick={() => onRetry(root.key)}>Retry</button>
          </div>
        ) : !total ? (
          <div className="rd-msg">
            <p>{allFiles ? 'This root is empty.' : 'No documents in this root - try All files.'}</p>
          </div>
        ) : (
          <>
            {folders.map((f) => (
              <div className="rd-folder" key={f.dir || '.'}>
                {/* Truncated from the LEFT, via the same helper the Explorer's
                    search hits use, and for the same measured reason: the tail
                    of a folder path is what distinguishes it, and CSS's
                    text-overflow can only cut the end. `docs/brand/foundations`
                    and `docs/brand/patterns` are identical for the first
                    eleven characters. */}
                {/* A BUTTON, because it is the "cd into this" control.
                    Scoping is what makes a big root usable: ~ is 3,200 entries
                    and 360ms, any one folder inside it is a handful and 9ms, and
                    the service now walks from the folder rather than filtering a
                    full listing. The label is unchanged, so nothing moves - it
                    just became something you can press. */}
                <button
                  type="button"
                  className="rd-folder-h mono"
                  title={`Only show ${root.key}/${f.dir}`}
                  onClick={() => onScope(root.key, f.dir)}
                  disabled={!f.dir}
                >
                  {tailPath(folderLabel(f.dir, root.key), 32)}
                </button>
                <ul className="rd-list">
                  {f.files.map((e) => (
                    <DocRow
                      key={e.path}
                      entry={e}
                      root={root.key}
                      current={root.key === currentRoot ? current : ''}
                      onOpen={onOpen}
                    />
                  ))}
                </ul>
              </div>
            ))}
            {total > MAX_ROWS && (
              <p className="rd-more">
                {(total - MAX_ROWS).toLocaleString()} more in this root - use the search above.
              </p>
            )}
            {/* The listing cap, carried through from /tree. The Explorer says
                this in the Problems panel, which the reader does not have. */}
            {tree?.truncated && (
              <p className="rd-more warn">
                The file service stopped listing this root at its own cap, so files
                below it are missing here. A search still reaches them.
              </p>
            )}
            {!allFiles && hidden > 0 && (
              <p className="rd-more">
                {hidden.toLocaleString()} more file{hidden === 1 ? '' : 's'} that are not documents.
              </p>
            )}
          </>
        )
      )}
    </section>
  );
}

export function DocIndex({
  roots, trees, openRoots, onToggleRoot, allFiles, onAllFiles,
  currentRoot, currentPath, onOpen, onRetry, onScope, scope,
}: {
  roots: FileRoot[];
  trees: Record<string, RootTree | undefined>;
  openRoots: ReadonlySet<string>;
  onToggleRoot: (root: string) => void;
  allFiles: boolean;
  onAllFiles: (on: boolean) => void;
  currentRoot: string;
  currentPath: string;
  onOpen: (root: string, path: string) => void;
  onRetry: (root: string) => void;
  /** Narrow the listing to one folder, the way `cd` narrows what `ls` shows.
   *  '' is the whole root again. */
  onScope: (root: string, dir: string) => void;
  /** The folder currently scoped into, root-relative, '' for the whole root.
   *  Only DocIndex needs it - it draws the breadcrumb; RootSection is handed
   *  the callback and nothing else. */
  scope: string;
}) {
  const box = useRef<HTMLDivElement | null>(null);

  // Keep the open document visible in the index. It matters most for the case
  // this reader exists to serve: following a relative link three documents deep
  // moves the selection to a row that may be hundreds below the fold, and an
  // index that does not follow stops being a place you know where you are.
  //
  // `nearest` is doing real work - it is a no-op when the row is already on
  // screen, so browsing the list by hand is never yanked out from under the
  // pointer. The frame's wait is for the row itself: a root that has just been
  // opened has not rendered its listing yet.
  useEffect(() => {
    if (!currentPath) return;
    const raf = requestAnimationFrame(() => {
      box.current
        ?.querySelector(`[data-root="${CSS.escape(currentRoot)}"][data-path="${CSS.escape(currentPath)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [currentRoot, currentPath, trees, allFiles]);

  return (
    <div className="rd-index" ref={box}>
      <div className="rd-index-h">
        <span className="rd-index-title">Documents</span>
        {/* Not an icon and not in a menu. It changes what the list CLAIMS to be
            - a library or a filesystem - and a control that changes the meaning
            of everything below it has to be visible while you read them. */}
        <label className="rd-all">
          <input
            type="checkbox"
            checked={allFiles}
            onChange={(e) => onAllFiles(e.target.checked)}
          />
          <Layers size={12} aria-hidden="true" />
          <span>All files</span>
        </label>
      </div>

      {/* THE WAY BACK. Only rendered while scoped, because a breadcrumb reading
          just the root name is furniture - and the whole argument of this panel
          is that the rarer case must not tax the common one.

          Each segment is a step back UP, which is what a breadcrumb means, and
          the last one is not a link: you are already there. */}
      {scope && (
        <nav className="rd-crumbs" aria-label="Folder">
          <button type="button" onClick={() => onScope(currentRoot, '')}>
            {currentRoot}
          </button>
          {scope.split('/').map((seg: string, i: number, all: string[]) => {
            const upto = all.slice(0, i + 1).join('/');
            const here = i === all.length - 1;
            return (
              <span key={upto}>
                <span className="rd-crumb-sep">/</span>
                {here ? <b>{seg}</b> : (
                  <button type="button" onClick={() => onScope(currentRoot, upto)}>{seg}</button>
                )}
              </span>
            );
          })}
        </nav>
      )}

      {roots.map((r) => (
        <RootSection
          key={r.key}
          root={r}
          tree={trees[r.key]}
          open={openRoots.has(r.key)}
          onToggle={() => onToggleRoot(r.key)}
          allFiles={allFiles}
          current={currentPath}
          currentRoot={currentRoot}
          onOpen={onOpen}
          onRetry={onRetry}
          onScope={onScope}
        />
      ))}
    </div>
  );
}
