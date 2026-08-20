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
//   · IT IS PROSE FIRST. Markdown, rst and txt. Everything else - 117 code
//     files and 42 configs in the stacks root alone - is behind one "All files"
//     toggle. The reader is NOT lied to about what is there; the order is by
//     what the page is for, and the count of what is hidden is printed next to
//     the switch that reveals it.
//   · IT IS A TREE (#150). It was flat inside a root - a folder heading, then
//     its documents, then the next folder - on the argument that prose is ~84
//     files and a tree exists to make 3,500 navigable. That was right for a
//     panel listing four roots of loose prose and wrong for everything else: it
//     cannot express nesting past one level, and the moment "All files" is on it
//     hits its own row cap. `docs/brand/foundations` and `docs/brand/patterns`
//     were two sibling headings identical for their first eleven characters.
//
//     THE TREE IS buildTree() FROM tree.ts, the one the Explorer renders. A
//     second tree here is how two panels come to disagree about a folder they
//     both list, and the property that makes it scale - a closed directory puts
//     NOTHING in the DOM - is exactly the property this panel needs.
//
// A ROOT IS LOADED WHEN IT IS OPENED, not on mount. /tree is capped at 4,000
// entries per root (portal-files/app.py MAX_LISTING) and there are four roots,
// so listing all of them up front is up to 16,000 entries of JSON to render a
// panel whose first screen is eighteen notes. The root the URL names is open on
// arrival; the others are one click.

import { useEffect, useMemo, useRef } from 'react';
import { ChevronRight, FileText, Folder, FolderOpen, Layers, Lock } from 'lucide-react';
import { fmtBytes, type FileRoot, type TreeFile } from '../../lib/files';
import { FileIcon } from './icons';
import { isProse, stemOf, titleOf } from './titles';
import { buildTree, type Node } from './tree';
import { sortGuide } from './guide';

/** What one root's listing is doing. Held by the Reader, one per root. */
export interface RootTree {
  entries: TreeFile[];
  truncated: boolean;
  loading: boolean;
  err: string | null;
}

/** Files fed to the tree for one root before the panel gives up and says so.
 *
 *  Only reachable with "All files" on: prose tops out at 69 files in the largest
 *  root. It is the same refusal the Explorer's search results make at 250 and
 *  the tree listing makes at 4,000 - a list that silently stops is how someone
 *  concludes a file is not there.
 *
 *  It caps the ENTRIES fed to the tree rather than the ROWS rendered, which the
 *  flat list used to do. A tree renders only what is open, so a row cap would
 *  cut a different set of files every time a folder was toggled. */
const MAX_FILES = 1200;

/** Lowercase, and every separator run collapsed to one space - so `a-b_c.md`
 *  and "A b c" compare equal. Used only to decide whether a row's title and its
 *  filename are the same string wearing different punctuation. */
const fold = (s: string) => s.toLowerCase().replace(/[-_.\s]+/g, ' ').trim();

/** The key an expand/collapse state is held under. Both halves, because `home`
 *  aliases every other root: the same relative directory exists in two open
 *  sections, and keying on the directory alone would open both at once. */
export const dirKey = (root: string, dir: string) => `${root} ${dir}`;

/** Every directory on the way down to `path`, as expand keys. Used to open the
 *  route to the document the URL names, so following a link three folders deep
 *  leaves the index showing where you are rather than a collapsed root. */
export function openTo(root: string, path: string): string[] {
  const out: string[] = [];
  let at = path.indexOf('/');
  while (at !== -1) { out.push(dirKey(root, path.slice(0, at))); at = path.indexOf('/', at + 1); }
  return out;
}

/**
 * The entries this panel will draw, as a tree.
 *
 * `strip` removes a leading folder from every path BEFORE the tree is built,
 * which is what stops the guide rendering as `docs` > `guide` > seven files: the
 * listing is fetched scoped (`?path=docs/guide`) but the service still returns
 * root-relative paths, so without this the panel spends two levels of indent
 * redrawing the folder you are already in.
 *
 * THE STRIPPED PATH IS A DISPLAY AND EXPAND-STATE KEY AND NOTHING ELSE. Every
 * node in the returned tree - including `node.entry.path`, which is a rewritten
 * copy - carries the SHORT path, so nothing here may be handed to anything that
 * opens a file. The caller puts the prefix back (`realPath` below), which it can
 * do exactly because the prefix is one known string. Read from `entry.path`
 * instead and a guide row opens `?path=index.md`, which is a real file in
 * neither place - caught exactly that way.
 */
function treeOf(
  entries: TreeFile[], prose: boolean, strip: string,
): { root: Node; total: number; hidden: number } {
  const cut = strip ? `${strip.replace(/\/+$/, '')}/` : '';
  const keep: TreeFile[] = [];
  let total = 0;
  let hidden = 0;
  for (const e of entries) {
    if (e.dir === true) continue;
    if (prose && !isProse(e.path)) { hidden++; continue; }
    total++;
    if (total > MAX_FILES) continue;
    keep.push(cut && e.path.startsWith(cut) ? { ...e, path: e.path.slice(cut.length) } : e);
  }
  return { root: buildTree(keep), total, hidden };
}

/** A node's path as the SERVICE knows it - the prefix treeOf took off, put back.
 *  This is the only path that may be opened, put in a URL, or compared against
 *  the open document. */
const realPath = (node: Node, strip: string) =>
  (strip ? `${strip.replace(/\/+$/, '')}/${node.path}` : node.path);

function DocRow({ node, root, current, depth, strip, onOpen }: {
  node: Node; root: string; current: string; depth: number; strip: string;
  onOpen: (root: string, path: string) => void;
}) {
  const entry = node.entry;
  // The TRUE path - what opens, and what the URL carries. NEVER `entry.path`:
  // treeOf rewrote that one too. See realPath.
  const real = realPath(node, strip);
  const on = real === current;
  const denied = entry?.readable === false;
  const name = node.name;
  const prose = isProse(name);
  // A title is a CLAIM about what the file is for, and it is only honest for
  // prose. `compose.yml` prettified to "Compose" would be inventing a document.
  const label = prose ? titleOf(name) : name;
  // The filename under the title, and only when the title is not already the
  // filename. Compared with the separators FOLDED, which is the whole point:
  // "Tailnet performance" and `tailnet-performance.md` are the same string with
  // different punctuation, and printing both put a second line under most rows
  // that carried no information at all.
  const sub = prose && fold(stemOf(name)) !== fold(label) ? name : '';

  return (
    <li className="rd-li">
      <button
        type="button"
        className={`rd-doc${on ? ' on' : ''}${denied ? ' denied' : ''}`}
        style={{ paddingLeft: `${8 + depth * 13}px` }}
        // Both halves, because `home` mirrors the other roots: the same relative
        // path exists in two open sections, and a lookup on the path alone would
        // scroll to whichever rendered first.
        data-root={root}
        data-path={real}
        aria-current={on ? 'true' : undefined}
        aria-disabled={denied || undefined}
        disabled={denied}
        onClick={() => onOpen(root, real)}
        title={denied
          ? `${real} - this session may not read it`
          : `${root}/${real}${entry ? ` · ${fmtBytes(entry.size)}` : ''}`}
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

/** One level of the tree. Recursive, and a CLOSED directory renders nothing -
 *  the property tree.ts's header calls out, and the reason this scales to "All
 *  files" on a 3,500-entry root with no virtualiser. */
function TreeRows({ nodes, depth, root, current, open, onToggle, onOpen, order, strip }: {
  nodes: Node[];
  depth: number;
  root: string;
  /** The open document's TRUE path, to mark the row that is it. */
  current: string;
  /** The prefix treeOf removed, so rows can put it back. '' when none was. */
  strip: string;
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onOpen: (root: string, path: string) => void;
  /** Reorder the FILES at each level. The guide has a reading order; every other
   *  listing keeps buildTree's directories-then-alphabetical, which is what
   *  every file explorer does and what makes a deep path predictable to scan. */
  order?: (nodes: Node[]) => Node[];
}) {
  const dirs = nodes.filter((n) => n.dir);
  const plain = nodes.filter((n) => !n.dir);
  const files = order ? order(plain) : plain;
  return (
    <ul className="rd-list">
      {dirs.map((n) => {
        const key = dirKey(root, n.path);
        const isOpen = open.has(key);
        return (
          <li key={n.path} className="rd-li">
            <button
              type="button"
              className="rd-dir"
              style={{ paddingLeft: `${8 + depth * 13}px` }}
              aria-expanded={isOpen}
              onClick={() => onToggle(key)}
              title={`${n.path} - ${n.files.toLocaleString()} document${n.files === 1 ? '' : 's'}`}
            >
              <ChevronRight size={12} className={`rd-chev${isOpen ? ' open' : ''}`} aria-hidden="true" />
              {isOpen
                ? <FolderOpen size={13} className="rd-dir-ico" aria-hidden="true" />
                : <Folder size={13} className="rd-dir-ico" aria-hidden="true" />}
              <span className="rd-dir-name">{n.name}</span>
              <span className="rd-dir-n tnum">{n.files.toLocaleString()}</span>
            </button>
            {isOpen && n.children.length > 0 && (
              <TreeRows
                nodes={n.children}
                depth={depth + 1}
                root={root}
                current={current}
                open={open}
                onToggle={onToggle}
                onOpen={onOpen}
                order={order}
                strip={strip}
              />
            )}
          </li>
        );
      })}
      {files.map((n) => (
        <DocRow
          key={n.path}
          node={n}
          root={root}
          current={current}
          depth={depth}
          strip={strip}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

function RootSection({
  root, tree, open, onToggle, allFiles, current, currentRoot, onOpen, onRetry, dirs, onToggleDir,
  strip = '',
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
  dirs: ReadonlySet<string>;
  onToggleDir: (key: string) => void;
  /** A folder prefix to remove from every path before the tree is built - see
   *  treeOf. Set while this root is the scoped one, so a scoped listing does not
   *  redraw the folder the breadcrumb above already names. */
  strip?: string;
}) {
  const entries = tree?.entries ?? [];
  const { root: node, total, hidden } = useMemo(
    () => treeOf(entries, !allFiles, strip),
    [entries, allFiles, strip],
  );

  return (
    <section className="rd-root" aria-label={root.label || root.key}>
      <h3 className="rd-root-h">
        <button type="button" className="rd-root-btn" aria-expanded={open} onClick={onToggle}>
          <ChevronRight size={12} className={`rd-chev${open ? ' open' : ''}`} aria-hidden="true" />
          <span className="rd-root-name mono">{root.key}</span>
          {root.readOnly && <Lock size={10} className="rd-root-ro" aria-label="read-only" />}
          {open && !tree?.loading && (
            <span className="rd-root-n tnum">{total > MAX_FILES ? `${MAX_FILES}+` : total}</span>
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
            <TreeRows
              nodes={node.children}
              depth={0}
              root={root.key}
              current={root.key === currentRoot ? current : ''}
              open={dirs}
              onToggle={onToggleDir}
              onOpen={onOpen}
              strip={strip}
            />
            {total > MAX_FILES && (
              <p className="rd-more">
                {(total - MAX_FILES).toLocaleString()} more in this root - use the search above.
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

/**
 * The guide's own index (#149, #150). One root, drawn as no root at all.
 *
 * No section header, no chevron, no lock glyph, no count - there is nothing to
 * choose between, and a root selector on a manual makes it a filesystem browser
 * that happens to be showing a manual. The scope is stripped off the paths so
 * the panel does not spend two levels of indent redrawing the folder you are
 * already in, and the files are in the guide's READING order rather than
 * alphabetical: these pages end in `## Next`, and configuring-before-installing
 * is backwards.
 *
 * Prose only, and NOT behind a toggle: `docs/guide` holds markdown and nothing
 * else, so an "All files" switch here is a control that can only ever do
 * nothing.
 */
function GuideIndex({ root, tree, strip, current, onOpen, onRetry, dirs, onToggleDir }: {
  root: string;
  tree: RootTree | undefined;
  strip: string;
  current: string;
  onOpen: (root: string, path: string) => void;
  onRetry: (root: string) => void;
  dirs: ReadonlySet<string>;
  onToggleDir: (key: string) => void;
}) {
  const { root: node, total } = useMemo(
    () => treeOf(tree?.entries ?? [], true, strip),
    [tree, strip],
  );
  // Ranked on the node's own (stripped) name, which is all guideRank reads -
  // it takes the basename off whatever it is given, so the prefix is irrelevant
  // here and putting it back first would be work for no answer.
  const order = useMemo(() => (ns: Node[]) => sortGuide(ns, (n) => n.path), []);

  if (!tree || tree.loading) {
    return (
      <div className="rd-skel" aria-hidden="true">
        {Array.from({ length: 7 }, (_, i) => <span className="skel" key={i} />)}
      </div>
    );
  }
  if (tree.err) {
    return (
      <div className="rd-msg">
        <p>{tree.err}</p>
        <button type="button" className="btn ghost sm" onClick={() => onRetry(root)}>Retry</button>
      </div>
    );
  }
  if (!total) {
    // The guide is files in THIS repository, so an empty listing means the
    // `stacks` root is not mounted or the folder moved - a fact worth stating
    // rather than an empty panel to stare at. Same refusal Start makes when
    // DOCS_ROOT is absent: draw nothing rather than rows that all 404.
    return (
      <div className="rd-msg">
        <p>The guide is not in this checkout - <span className="mono">{strip}</span> is empty or missing.</p>
      </div>
    );
  }
  return (
    <TreeRows
      nodes={node.children}
      depth={0}
      root={root}
      current={current}
      open={dirs}
      onToggle={onToggleDir}
      onOpen={onOpen}
      order={order}
      strip={strip}
    />
  );
}

export function DocIndex({
  roots, trees, openRoots, onToggleRoot, allFiles, onAllFiles,
  currentRoot, currentPath, onOpen, onRetry, dirs, onToggleDir, guide, scope = '', onScope,
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
  /** Which directories are expanded, keyed by `dirKey(root, dir)`. Held by the
   *  Reader, because following a cross-document link has to open the route down
   *  to the new file and that is the Reader's event, not this panel's. */
  dirs: ReadonlySet<string>;
  onToggleDir: (key: string) => void;
  /** Present in GUIDE mode, and its presence IS the mode: one root, one folder,
   *  no chooser. Absent is the reader over every root. The caller resolves the
   *  scoped listing into `trees[guide.root]` before handing it over, because the
   *  composite key the Reader stores it under is the Reader's business. */
  guide?: { root: string; dir: string };
  /** The folder currently scoped into, root-relative, '' for the whole root.
   *  Browse mode only - the guide is permanently scoped and has no way out of
   *  its own folder by design. */
  scope?: string;
  /** Narrow the listing to one folder, the way `cd` narrows what `ls` shows.
   *  '' is the whole root again. Reached from Start's shelf (the plans folder
   *  card) and left by the breadcrumb below. */
  onScope?: (root: string, dir: string) => void;
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
  // opened, or a folder that has just been expanded, has not rendered yet.
  useEffect(() => {
    if (!currentPath) return;
    const raf = requestAnimationFrame(() => {
      box.current
        ?.querySelector(`[data-root="${CSS.escape(currentRoot)}"][data-path="${CSS.escape(currentPath)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [currentRoot, currentPath, trees, allFiles, dirs]);

  if (guide) {
    return (
      <div className="rd-index rd-index-guide" ref={box}>
        <div className="rd-index-h">
          <span className="rd-index-title">The guide</span>
        </div>
        <GuideIndex
          root={guide.root}
          tree={trees[guide.root]}
          strip={guide.dir}
          current={currentPath}
          onOpen={onOpen}
          onRetry={onRetry}
          dirs={dirs}
          onToggleDir={onToggleDir}
        />
      </div>
    );
  }

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

      {/* THE WAY BACK OUT OF A FOLDER. Only rendered while scoped, because a
          breadcrumb reading just the root name is furniture - and the whole
          argument of this panel is that the rarer case must not tax the common
          one. Each segment is a step back UP, which is what a breadcrumb means,
          and the last one is not a link: you are already there. */}
      {scope && onScope && (
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
          dirs={dirs}
          onToggleDir={onToggleDir}
          // Only the scoped root strips its prefix, and only while it IS the
          // scoped one - the other sections are listing whole roots.
          strip={scope && r.key === currentRoot ? scope : ''}
        />
      ))}
    </div>
  );
}
