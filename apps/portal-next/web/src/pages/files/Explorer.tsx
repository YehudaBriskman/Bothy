// ── the left rail ────────────────────────────────────────────────────────────
//
// Denser than a page list and for the same reason VS Code's is: the rail is
// scanned, not read. Rows are 22px, the indent step is 12px, and each level
// carries a hairline GUIDE rather than whitespace - at four levels deep, spaces
// alone stop telling you which parent a row belongs to, and the guide is the
// cheapest thing that does (one border on a pseudo-element, no extra DOM).
//
// The lazy tree is unchanged and is the reason this scales: a closed directory
// renders NOTHING, so the 2,748-file `projects` root costs about one DOM row
// until someone opens something. Search switches the rail to a flat ranked list
// capped at 250 with a count of what was left out - at this scale search IS the
// navigation, and an uncapped result list is a second way to render everything.

import { useMemo } from 'react';
import {
  ChevronRight, ChevronsDownUp, FileDown, Folder, FolderOpen, Lock, Locate, Search, X,
} from 'lucide-react';
import { fmtBytes, type FileRoot, type TreeFile } from '../../lib/files';
import { Tooltip } from '../../components/Tooltip';
import { FileIcon } from './icons';
import { baseName, dirName, tailPath, type Node } from './tree';

export const MAX_RESULTS = 250;

export interface Results { total: number; shown: TreeFile[] }

function TreeRows({
  nodes, depth, expanded, onToggle, current, onPick, onDownloadDir,
}: {
  nodes: Node[];
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  current: string;
  onPick: (path: string) => void;
  onDownloadDir: (node: Node) => void;
}) {
  return (
    <ul className="fx-list">
      {nodes.map((n) => {
        // A path the service says we may not read. Shown rather than hidden -
        // "there is something here you cannot open" is information, and a file
        // that silently vanishes is the kind of gap people debug for an hour -
        // but it is a disabled row, so it can never look openable.
        const denied = n.entry?.readable === false;
        const pad = { paddingLeft: `${6 + depth * 12}px` };

        if (n.dir) {
          const open = expanded.has(n.path);
          return (
            <li key={n.path} className="fx-li">
              <div className={`fx-rowwrap ${open ? 'open' : ''}`}>
                <button
                  type="button"
                  className="fx-row fx-dir"
                  style={pad}
                  aria-expanded={open}
                  onClick={() => onToggle(n.path)}
                  title={`${n.path} - ${n.files.toLocaleString()} files, ${fmtBytes(n.bytes)}`}
                >
                  <ChevronRight size={12} className={`fx-chev ${open ? 'open' : ''}`} aria-hidden="true" />
                  {open
                    ? <FolderOpen size={13} className="fx-ico t-dir" aria-hidden="true" />
                    : <Folder size={13} className="fx-ico t-dir" aria-hidden="true" />}
                  <span className="fx-name">{n.name}</span>
                  <span className="fx-n">{n.files.toLocaleString()}</span>
                </button>
                {/* Per-directory download. On the row rather than in a menu
                    because it is the only action a directory HAS, and a menu for
                    one item is a click spent on nothing. */}
                <button
                  type="button"
                  className="fx-rowbtn"
                  onClick={(e) => { e.stopPropagation(); onDownloadDir(n); }}
                  title={`Download ${n.name} as an archive - ${n.files.toLocaleString()} files, ${fmtBytes(n.bytes)}`}
                  aria-label={`Download ${n.path} as an archive`}
                >
                  <FileDown size={12} aria-hidden="true" />
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
                />
              )}
            </li>
          );
        }

        const on = n.path === current;
        const writable = n.entry?.writable !== false;
        return (
          <li key={n.path} className="fx-li">
            <button
              type="button"
              className={`fx-row fx-file ${on ? 'on' : ''} ${denied ? 'denied' : ''}`}
              style={pad}
              data-path={n.path}
              aria-current={on ? 'true' : undefined}
              aria-disabled={denied || undefined}
              disabled={denied}
              onClick={() => !denied && onPick(n.path)}
              title={denied
                ? `${n.path} - this session may not read it`
                : `${n.path}${n.entry ? ` · ${fmtBytes(n.entry.size)}` : ''}${writable ? '' : ' · read-only'}`}
            >
              {denied
                ? <Lock size={13} className="fx-ico t-denied" aria-hidden="true" />
                : <FileIcon name={n.name} />}
              <span className="fx-name">{n.name}</span>
              {!writable && !denied && <Lock size={10} className="fx-ro" aria-hidden="true" />}
              {n.entry && !denied && <span className="fx-size">{fmtBytes(n.entry.size)}</span>}
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
  loading, error, onRetry, truncated, fileCount, filterRef,
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
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  truncated: boolean;
  fileCount: number;
  filterRef: React.RefObject<HTMLInputElement | null>;
}) {
  const shownCount = results
    ? `${Math.min(results.total, MAX_RESULTS).toLocaleString()} of ${results.total.toLocaleString()}`
    : fileCount.toLocaleString();

  const rootMeta = useMemo(() => roots.find((r) => r.key === root), [roots, root]);

  return (
    <aside className="fx-rail fx-rail-l" aria-label="Explorer">
      <div className="fx-rail-h">
        <span className="fx-rail-title">Explorer</span>
        <span className="fx-rail-sub tnum">{shownCount}</span>
        <Tooltip label="Collapse every folder">
          <button type="button" className="fx-hbtn" onClick={onCollapseAll} aria-label="Collapse all folders">
            <ChevronsDownUp size={14} />
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
            <Locate size={14} />
          </button>
        </Tooltip>
        <Tooltip label={`Download all of ${root} as an archive`} align="end">
          <button type="button" className="fx-hbtn" onClick={onDownloadRoot} aria-label={`Download ${root}`}>
            <FileDown size={14} />
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
              {r.readOnly && <Lock size={10} className="fx-rootro" aria-label="read-only" />}
            </button>
          ))}
        </div>
      )}

      {/* The primary affordance at this scale, so it is above the tree and
          always visible rather than a control you have to find. */}
      <label className="fx-filter">
        <Search size={13} aria-hidden="true" />
        <span className="sr-only">Filter files by path</span>
        <input
          ref={filterRef}
          type="search"
          value={query}
          placeholder="Search paths…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
        />
        {query && (
          <button type="button" className="fx-filter-x" onClick={() => setQuery('')} aria-label="Clear filter">
            <X size={12} />
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
            <button type="button" className="btn ghost" onClick={onRetry}>Retry</button>
          </div>
        ) : results ? (
          results.shown.length === 0 ? (
            <div className="fx-msg"><p>Nothing matches “{query}”.</p></div>
          ) : (
            <>
              <ul className="fx-list">
                {results.shown.map((e) => (
                  <li key={e.path} className="fx-li">
                    <button
                      type="button"
                      className={`fx-row fx-file fx-hit ${e.path === current ? 'on' : ''} ${e.readable === false ? 'denied' : ''}`}
                      disabled={e.readable === false}
                      aria-disabled={e.readable === false || undefined}
                      onClick={() => onPick(e.path)}
                      title={e.path}
                    >
                      {e.readable === false
                        ? <Lock size={13} className="fx-ico t-denied" aria-hidden="true" />
                        : <FileIcon name={e.path} />}
                      {/* The basename with its folder under it - at this scale
                          the name alone is ambiguous (six compose.yml, four
                          README.md). */}
                      <span className="fx-hit-text">
                        <span className="fx-name">{baseName(e.path)}</span>
                        <span className="fx-hit-dir">{tailPath(dirName(e.path).replace(/\/$/, '') || root)}</span>
                      </span>
                      <span className="fx-size">{fmtBytes(e.size)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {results.total > MAX_RESULTS && (
                <p className="fx-more">
                  {(results.total - MAX_RESULTS).toLocaleString()} more match - narrow the search.
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
          />
        )}
      </div>

      <footer className="fx-rail-f">
        <span className="mono">{root}</span>
        <span className="fx-rail-f-sep" aria-hidden="true">·</span>
        <span className="tnum">{fileCount.toLocaleString()} files</span>
        <span className="tnum fx-rail-f-bytes">{fmtBytes(tree.bytes)}</span>
        {rootMeta?.readOnly && <span className="tag">read-only</span>}
        {truncated && <span className="tag warn">truncated</span>}
      </footer>
    </aside>
  );
}
