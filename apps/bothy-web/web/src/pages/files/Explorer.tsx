// ── the left rail ────────────────────────────────────────────────────────────
//
// Denser than a page list and for the same reason VS Code's is: the rail is
// scanned, not read. Rows are 22px, the indent step is 12px, and each level
// carries a hairline GUIDE rather than whitespace - at four levels deep, spaces
// alone stop telling you which parent a row belongs to, and the guide is the
// cheapest thing that does (one border on a pseudo-element, no extra DOM).
//
// The lazy tree is unchanged and is the reason this scales: a closed directory
// renders NOTHING, so the 19,273-file `projects` root costs about one DOM row
// until someone opens something.
//
// WHAT CHANGED IN 2026-10 is the other half of that sentence: the LISTING went
// lazy too. It used to be one request per root for every file under it, which the
// service capped at 4,000 entries - so the rail rendered a handful of rows out of
// 1.18 MB of JSON and ~15,000 files per big root had no path this page had ever
// seen. Two consequences are visible here:
//
//   · a folder row now knows whether its own listing has arrived, so "nobody has
//     opened this" and "this folder is empty" are different states on screen. The
//     subtree file count and byte total are GONE with the rollup that fed them -
//     see tree.ts - and what a folder costs is asked when Download is clicked.
//   · the filter is a SERVER search (/find), so it reaches every file in the root
//     rather than the first 4,000. It still renders as a flat ranked list capped
//     at 250 with a count of what was left out: at this scale search IS the
//     navigation, and an uncapped result list is a second way to render
//     everything.

import { useMemo } from 'react';
import {
  ChevronRight, ChevronsDownUp, FileDown, FileX2, Folder, FolderOpen, Lock, Locate, Search, X,
} from 'lucide-react';
import { fmtBytes, type FileRoot, type Stopped, type TreeFile } from '../../lib/files';
import { Tooltip } from '../../components/Tooltip';
import { FileIcon } from './icons';
import { baseName, dirName, tailPath, type Node } from './tree';
import { toneFor, type Decorations } from './gitdeco';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Loader } from '../../components/ui/Loader';

export const MAX_RESULTS = 250;

export interface Results {
  total: number;
  shown: TreeFile[];
  /** The SERVICE's bound, reported rather than inferred from a length - a list
   *  exactly `limit` long is not proof it was cut. Null when the walk finished. */
  stopped?: Stopped | null;
  /** The search itself failed. Shown in the rail where the query was typed, not in
   *  the Problems panel: a search that errors is about the box you are typing in. */
  err?: string;
}

function TreeRows({
  nodes, depth, expanded, onToggle, current, onPick, onDownloadDir, deco, tombs, onOpenDiff,
  pending, sizing,
}: {
  nodes: Node[];
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  current: string;
  onPick: (path: string) => void;
  onDownloadDir: (node: Node) => void;
  /** Git state for every path git mentioned, plus the colour that has to reach
   *  the collapsed folders above it. */
  deco: Decorations;
  /** Paths that are in `/status` and CANNOT be on disk. See the tombstone row
   *  below - the alternative is a file that silently is not there. */
  tombs: Set<string>;
  onOpenDiff: (path: string) => void;
  /** Folders whose listing is in flight. */
  pending: ReadonlySet<string>;
  /** The folder being weighed for a download, if any. The walk takes up to two
   *  seconds on the biggest subtree here, and a button that looks dead for two
   *  seconds reads as a broken button. */
  sizing: string | null;
}) {
  return (
    // --depth: explorer.css draws this list's guide stripe from it, so a tree of
    // any depth puts every stripe under its own chevron (FL-11). It was three
    // hand-written selectors, and anything past depth 3 drew at depth 3's
    // position - a guide pointing at the wrong parent.
    <ul className="fx-list" style={{ ['--depth' as string]: depth }}>
      {nodes.map((n) => {
        // A path the service says we may not read. Shown rather than hidden -
        // "there is something here you cannot open" is information, and a file
        // that silently vanishes is the kind of gap people debug for an hour -
        // but it is a disabled row, so it can never look openable.
        const denied = n.entry?.readable === false;
        // rem steps (the indent follows the text size); explorer.css draws the guide
        // stripes from the same two tokens.
        const pad = { paddingLeft: `calc(var(--sp-1_5) + ${depth} * var(--sp-3))` };

        if (n.dir) {
          const open = expanded.has(n.path);
          const busy = pending.has(n.path);
          // The propagation that makes a change visible without expanding
          // anything. A closed folder is one row and no children, so without
          // this the only way to find a modification is to already know where
          // it is.
          const dd = deco.dirs.get(n.path);
          // The count is the entries DIRECTLY INSIDE, and only once the listing
          // has arrived. It used to be the number of files in the whole subtree,
          // which no client can know without holding the subtree - see tree.ts on
          // the rollups this replaced. An unlisted folder shows nothing rather
          // than a 0, because 0 is a claim and "not asked yet" is not.
          const kids = n.loaded ? n.children.length : null;
          const what = n.loaded
            ? `${kids?.toLocaleString()} ${kids === 1 ? 'entry' : 'entries'} here`
            : 'not listed yet - open it to see';
          return (
            <li key={n.path} className="fx-li">
              <div className={`fx-rowwrap ${open ? 'open' : ''}`}>
                <button
                  type="button"
                  className="fx-row fx-dir"
                  style={pad}
                  aria-expanded={open}
                  data-git={dd ? toneFor(dd.state) : undefined}
                  onClick={() => onToggle(n.path)}
                  title={`${n.path} - ${what}` + (dd ? ` · ${dd.count} changed` : '')}
                >
                  <Icon icon={ChevronRight} size="xs" className={`chev fx-chev ${open ? 'open' : ''}`} />
                  {open
                    ? <Icon icon={FolderOpen} size="sm" className="fx-ico t-dir" />
                    : <Icon icon={Folder} size="sm" className="fx-ico t-dir" />}
                  <span className="fx-name">{n.name}</span>
                  {/* The git count REPLACES the entry count when there is one.
                      Both in the same 10px column is two numbers that look
                      alike and mean nothing alike, and at this width one of
                      them has to go - the changed count is the one you are
                      looking for. The full pair stays in the title. */}
                  {dd
                    ? <span className="fx-gitn tnum">{dd.count}</span>
                    : busy
                      ? <Loader state="load" label={`Listing ${n.name}`} labelHidden />
                      : kids !== null && <span className="fx-n">{kids.toLocaleString()}</span>}
                </button>
                {/* Per-directory download. On the row rather than in a menu
                    because it is the only action a directory HAS, and a menu for
                    one item is a click spent on nothing.
                    NO SIZE IN THE LABEL: what the folder weighs is asked when this
                    is clicked, by the service that is about to build the archive -
                    see /dirsize. A number here would be the rollup again. */}
                <button
                  type="button"
                  className="fx-rowbtn"
                  onClick={(e) => { e.stopPropagation(); onDownloadDir(n); }}
                  disabled={sizing !== null}
                  title={sizing === n.path
                    ? `Working out what ${n.name} weighs…`
                    : `Download ${n.name} as an archive`}
                  aria-label={`Download ${n.path} as an archive`}
                >
                  {sizing === n.path
                    ? <Loader state="work" label={`Weighing ${n.name}`} labelHidden />
                    : <Icon icon={FileDown} size="xs" />}
                </button>
              </div>
              {/* Lazily rendered: a closed directory puts NOTHING in the DOM,
                  which is what lets this scale past a few thousand entries. */}
              {open && n.children.length > 0 && (
                <TreeRows
                  nodes={n.children}
                  depth={depth + 1}
                  expanded={expanded}
                  onToggle={onToggle}
                  current={current}
                  onPick={onPick}
                  onDownloadDir={onDownloadDir}
                  deco={deco}
                  tombs={tombs}
                  onOpenDiff={onOpenDiff}
                  pending={pending}
                  sizing={sizing}
                />
              )}
              {/* An OPEN folder with nothing in it says which kind of nothing.
                  The eager listing never had to: a folder it did not describe did
                  not exist. */}
              {open && n.children.length === 0 && (
                <p className="fx-nodir" style={pad}>
                  {busy ? 'Listing…' : n.loaded ? 'Empty' : 'Not listed'}
                </p>
              )}
            </li>
          );
        }

        const on = n.path === current;
        const writable = n.entry?.writable !== false;
        const d = deco.files.get(n.path);

        // ── the tombstone ──────────────────────────────────────────────────
        // A deleted file is in `/status` and cannot be in the tree, because the
        // tree is a listing of what is on disk. Leaving it out would make a
        // deletion the one change with no representation where you look for
        // files - so it gets a row of its own: struck through, marked D, and
        // opening the DIFF rather than the file, which is the only thing left
        // that can still be read.
        if (tombs.has(n.path)) {
          return (
            <li key={n.path} className="fx-li">
              <button
                type="button"
                className="fx-row fx-file fx-tomb"
                style={pad}
                data-path={n.path}
                data-git="down"
                onClick={() => onOpenDiff(n.path)}
                title={`${n.path} - deleted, and not yet committed. Opens the diff; the file itself is gone.`}
              >
                <Icon icon={FileX2} size="sm" className="fx-ico t-tomb" />
                <span className="fx-name">{n.name}</span>
                <span className="fx-gitcode t-down" aria-label="deleted">D</span>
              </button>
            </li>
          );
        }

        return (
          <li key={n.path} className="fx-li">
            <button
              type="button"
              className={`fx-row fx-file ${on ? 'on' : ''} ${denied ? 'denied' : ''}`}
              style={pad}
              data-path={n.path}
              data-git={d ? toneFor(d.state) : undefined}
              aria-current={on ? 'true' : undefined}
              aria-disabled={denied || undefined}
              disabled={denied}
              onClick={() => !denied && onPick(n.path)}
              title={denied
                ? `${n.path} - this session may not read it`
                : `${n.path}${n.entry?.size != null ? ` · ${fmtBytes(n.entry.size)}` : ''}${writable ? '' : ' · read-only'}`
                  + (d ? ` · ${d.label}${d.staged ? ', staged' : ''}` : '')}
            >
              {denied
                ? <Icon icon={Lock} size="sm" className="fx-ico t-denied" />
                : <FileIcon name={n.name} />}
              <span className="fx-name">{n.name}</span>
              {!writable && !denied && <Icon icon={Lock} size="xs" className="fx-ro" />}
              {/* The letter, not just the colour: the state has to survive a
                  monochrome screen and a reader who cannot tell amber from
                  green. It takes the size column, which the size can spare. */}
              {d
                ? <span className={`fx-gitcode t-${toneFor(d.state)} ${d.staged ? 'staged' : ''}`} aria-label={d.label}>{d.letter}</span>
                : n.entry?.size != null && !denied && <span className="fx-size">{fmtBytes(n.entry.size)}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function Explorer({
  roots, root, tree, results, query, setQuery, expanded, onToggleDir, current,
  onPick, onPickRoot, onCollapseAll, onReveal, onDownloadDir, onDownloadRoot,
  loading, pending, searching, sizing, error, onRetry, loadedCount, filterRef,
  deco, tombs, onOpenDiff,
}: {
  roots: FileRoot[];
  root: string;
  tree: Node;
  results: Results | null;
  query: string;
  setQuery: (q: string) => void;
  expanded: Set<string>;
  onToggleDir: (p: string) => void;
  current: string;
  onPick: (p: string) => void;
  onPickRoot: (r: string) => void;
  onCollapseAll: () => void;
  onReveal: () => void;
  onDownloadDir: (n: Node) => void;
  onDownloadRoot: () => void;
  /** The ROOT's own listing is in flight - the one skeleton this rail draws. A
   *  folder deeper in gets a spinner on its own row instead, because replacing the
   *  whole rail with a skeleton to open one folder loses your place. */
  loading: boolean;
  /** Every folder with a listing in flight. */
  pending: ReadonlySet<string>;
  /** The name search is in flight. Its own flag, because the tree being loaded and
   *  the search being slow are different waits with different answers. */
  searching: boolean;
  /** The folder whose archive size is being worked out, if any. */
  sizing: string | null;
  error: string | null;
  onRetry: () => void;
  /** Entries this rail HAS, not the root's total. The total is unknowable without
   *  the recursive listing that was removed, and the number it used to print was
   *  wrong anyway - it was the 4,000 the service's cap allowed. */
  loadedCount: number;
  filterRef: React.RefObject<HTMLInputElement | null>;
  deco: Decorations;
  tombs: Set<string>;
  onOpenDiff: (path: string) => void;
}) {
  const shownCount = results
    ? `${Math.min(results.total, MAX_RESULTS).toLocaleString()} of ${results.total.toLocaleString()}`
    : loadedCount.toLocaleString();

  const rootMeta = useMemo(() => roots.find((r) => r.key === root), [roots, root]);

  return (
    <aside className="fx-rail fx-rail-l" aria-label="Explorer">
      <div className="fx-rail-h">
        <span className="fx-rail-title">Explorer</span>
        <span className="fx-rail-sub tnum">{shownCount}</span>
        <Tooltip label="Collapse every folder">
          <button type="button" className="fx-hbtn" onClick={onCollapseAll} aria-label="Collapse all folders">
            <Icon icon={ChevronsDownUp} size="sm" />
          </button>
        </Tooltip>
        <Tooltip label="Reveal the open file in the tree">
          <button
            type="button"
            className="fx-hbtn"
            onClick={onReveal}
            disabled={!current}
            aria-label="Reveal the open file in the tree"
          >
            <Icon icon={Locate} size="sm" />
          </button>
        </Tooltip>
        <Tooltip label={`Download all of ${root} as an archive`} align="end">
          <button type="button" className="fx-hbtn" onClick={onDownloadRoot} aria-label={`Download ${root}`}>
            <Icon icon={FileDown} size="sm" />
          </button>
        </Tooltip>
      </div>

      {roots.length > 1 && (
        <div className="fx-roots" role="group" aria-label="Root">
          {roots.map((r) => (
            <button
              key={r.key}
              type="button"
              className={`fx-rootchip ${r.key === root ? 'on' : ''}`}
              aria-pressed={r.key === root}
              onClick={() => onPickRoot(r.key)}
              title={r.readOnly ? `${r.label || r.key} - read-only` : (r.label || r.key)}
            >
              {r.key}
              {/* A whole root that cannot be written to says so on its chip -
                  otherwise the only clue is every file in it turning out to have
                  no Edit button. */}
              {r.readOnly && <Icon icon={Lock} size="xs" className="fx-rootro" aria-label="read-only" />}
            </button>
          ))}
        </div>
      )}

      {/* The primary affordance at this scale, so it is above the tree and
          always visible rather than a control you have to find.
          IT IS A SERVER SEARCH NOW, over every file in the root (/find). It used
          to filter the listing the browser held, which stopped at the service's
          4,000-entry cap - so a name past the cap printed "Nothing matches". */}
      <label className="fx-filter">
        {searching
          ? <Loader state="search" label="Searching this root" labelHidden />
          : <Icon icon={Search} size="sm" />}
        <span className="sr-only">Search every file name in this root</span>
        <input
          ref={filterRef}
          type="search"
          value={query}
          placeholder="Search names in this root…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
        />
        {query && (
          <button type="button" className="fx-filter-x" onClick={() => setQuery('')} aria-label="Clear search">
            <Icon icon={X} size="xs" />
          </button>
        )}
      </label>

      <div className="fx-tree scroll-shade">
        {loading ? (
          <div className="fx-skel" aria-hidden="true">
            {Array.from({ length: 14 }, (_, i) => <span className="skel" key={i} />)}
          </div>
        ) : error ? (
          <div className="fx-msg">
            <p>{error}</p>
            <Button variant="ghost" onClick={onRetry}>Retry</Button>
          </div>
        ) : results ? (
          results.err ? (
            <div className="fx-msg">
              <p>The search failed: {results.err}</p>
              <Button variant="ghost" onClick={onRetry}>Retry</Button>
            </div>
          ) : results.shown.length === 0 ? (
            // "In this root", because that is the claim the server answered - and
            // it is now a claim worth making. The old filter could only say
            // "nothing in the 4,000 entries this browser happens to hold", which
            // it said as "Nothing matches".
            <div className="fx-msg">
              <p>No file name in <span className="mono">{root}</span> contains “{query}”.</p>
            </div>
          ) : (
            <>
              <ul className="fx-list">
                {results.shown.map((e) => {
                  // Search hits carry the same decoration as tree rows. They
                  // have to: at this scale the filter IS the navigation, and a
                  // state that only exists in one of the two views is a state
                  // half the users never see.
                  const d = deco.files.get(e.path);
                  return (
                    <li key={e.path} className="fx-li">
                      <button
                        type="button"
                        className={`fx-row fx-file fx-hit ${e.path === current ? 'on' : ''} ${e.readable === false ? 'denied' : ''}`}
                        disabled={e.readable === false}
                        aria-disabled={e.readable === false || undefined}
                        data-git={d ? toneFor(d.state) : undefined}
                        onClick={() => onPick(e.path)}
                        title={d ? `${e.path} · ${d.label}` : e.path}
                      >
                        {e.readable === false
                          ? <Icon icon={Lock} size="sm" className="fx-ico t-denied" />
                          : <FileIcon name={e.path} />}
                        {/* The basename with its folder under it - at this scale
                            the name alone is ambiguous (six compose.yml, four
                            README.md). */}
                        <span className="fx-hit-text">
                          <span className="fx-name">{baseName(e.path)}</span>
                          <span className="fx-hit-dir">{tailPath(dirName(e.path).replace(/\/$/, '') || root)}</span>
                        </span>
                        {d
                          ? <span className={`fx-gitcode t-${toneFor(d.state)} ${d.staged ? 'staged' : ''}`} aria-label={d.label}>{d.letter}</span>
                          : <span className="fx-size">{fmtBytes(e.size ?? 0)}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {/* THE SERVICE's bound, reported as the service reported it. This
                  used to be `total > MAX_RESULTS` over a list the browser had
                  scored itself; now the walk happens there, so the only honest
                  source for "there were more" is the `stopped` field. */}
              {results.stopped && (
                <p className="fx-more">
                  Stopped at {(results.stopped.limit ?? results.total).toLocaleString()} matches
                  ({results.stopped.reason}), out of {results.stopped.scanned.toLocaleString()} files
                  looked at - narrow the search.
                </p>
              )}
            </>
          )
        ) : tree.children.length === 0 ? (
          <div className="fx-msg"><p>This root is empty.</p></div>
        ) : (
          <TreeRows
            nodes={tree.children}
            depth={0}
            expanded={expanded}
            onToggle={onToggleDir}
            current={current}
            onPick={onPick}
            onDownloadDir={onDownloadDir}
            deco={deco}
            tombs={tombs}
            onOpenDiff={onOpenDiff}
            pending={pending}
            sizing={sizing}
          />
        )}
      </div>

      {/* WHAT THIS RAIL HOLDS, not what the root contains. The byte total is gone
          with the subtree rollup that produced it (tree.ts): a figure for a root
          nobody has walked is not a figure, and walking one to print it is the cost
          this page stopped paying. `truncated` is gone with the listing cap. */}
      <footer className="fx-rail-f">
        <span className="mono">{root}</span>
        <span className="fx-rail-f-sep" aria-hidden="true">·</span>
        <span className="tnum">{loadedCount.toLocaleString()} loaded</span>
        {rootMeta?.readOnly && <span className="tag">read-only</span>}
      </footer>
    </aside>
  );
}
