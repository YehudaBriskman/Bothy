// The tree model, and the path helpers every region shares.
//
// A REAL tree, built once from the flat listing, rendered lazily.
//
// The old flat "group by directory" list was right for 57 files in 9 folders and
// is wrong for thousands: it renders every row in the root whether or not anyone
// looks at it, and it cannot express nesting deeper than one level.
//
// Two properties make this survive the scale without a virtualiser:
//   · children of a COLLAPSED directory are never rendered - the DOM holds only
//     what is open, so a 2,748-entry root costs the handful of rows at its top
//     until someone opens something;
//   · the filter switches to a flat, capped result list, so the worst case is
//     MAX_RESULTS rows and not "every match in the repo".
// If a single directory ever holds thousands of siblings, THAT is the case that
// needs windowing - and it is a different fix from this one.

import type { TreeFile } from '../../lib/files';

export interface Node {
  name: string;
  path: string;
  dir: boolean;
  entry: TreeFile | null;
  children: Node[];
  /** Files at or below this node, and their total bytes. Computed once when the
   *  tree is built, because the explorer's per-directory download has to answer
   *  "is this folder over the archive cap?" before it opens a tab, and walking
   *  the subtree on every hover would do it thousands of times. */
  files: number;
  bytes: number;
}

function newNode(name: string, path: string, dir: boolean): Node {
  return { name, path, dir, entry: null, children: [], files: 0, bytes: 0 };
}

/**
 * @param entries the listing, as the service sent it.
 * @param tombs   paths that git says have been DELETED. They are not on disk,
 *                so they are not in `entries` - they are grafted in here so a
 *                deletion has a row where files live, and they are counted as
 *                ZERO files and ZERO bytes: the per-directory archive check
 *                reads those totals to decide whether a download would be
 *                refused, and a file that no longer exists must not move that
 *                answer.
 */
export function buildTree(entries: TreeFile[], tombs?: ReadonlySet<string>): Node {
  const root = newNode('', '', true);
  const index = new Map<string, Node>([['', root]]);

  // Directories are taken from the `dir` flag when the backend sends it as a
  // boolean, and INFERRED from the path separators otherwise - the live service
  // sends `dir` as the entry's PARENT PATH (a string), so the inference is what
  // actually runs. Both shapes work, which is why the tree cannot be broken by
  // the field settling on one meaning later.
  const ensureDir = (path: string): Node => {
    const found = index.get(path);
    if (found) { found.dir = true; return found; }
    const cut = path.lastIndexOf('/');
    const parent = ensureDir(cut === -1 ? '' : path.slice(0, cut));
    const node = newNode(path.slice(cut + 1), path, true);
    parent.children.push(node);
    index.set(path, node);
    return node;
  };

  for (const e of entries) {
    if (!e.path) continue;
    if (e.dir === true) { ensureDir(e.path).entry = e; continue; }
    const cut = e.path.lastIndexOf('/');
    const existing = index.get(e.path);
    if (existing) { existing.entry = e; continue; }
    const parent = ensureDir(cut === -1 ? '' : e.path.slice(0, cut));
    const node = newNode(e.path.slice(cut + 1), e.path, false);
    node.entry = e;
    parent.children.push(node);
    index.set(e.path, node);
  }

  // The graft. After the real entries, so a path that is somehow BOTH listed and
  // reported deleted keeps its real entry rather than being replaced by a stub.
  if (tombs) {
    for (const p of tombs) {
      if (!p || index.has(p)) continue;
      const cut = p.lastIndexOf('/');
      const parent = ensureDir(cut === -1 ? '' : p.slice(0, cut));
      const node = newNode(p.slice(cut + 1), p, false);
      parent.children.push(node);
      index.set(p, node);
    }
  }

  // Directories first, then files, each alphabetically - the ordering every file
  // explorer uses, and the one that makes a deep path predictable to scan.
  // `numeric` so incident-02 sorts before incident-10.
  const finish = (n: Node) => {
    n.children.sort((a, b) =>
      a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const c of n.children) {
      if (c.dir) finish(c);
      // `entry === null` on a FILE node means a tombstone and nothing else -
      // every listed file is given its entry above. It counts as no file and no
      // bytes, because it is not there.
      else { c.files = c.entry ? 1 : 0; c.bytes = c.entry?.size ?? 0; }
      n.files += c.files;
      n.bytes += c.bytes;
    }
  };
  finish(root);
  return root;
}

/** Every directory above `path`, deepest first. */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let at = path.lastIndexOf('/');
  while (at > 0) { out.push(path.slice(0, at)); at = path.lastIndexOf('/', at - 1); }
  return out;
}

export function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i + 1);
}

// Truncate a folder path from the LEFT, because its tail is what distinguishes
// one of twelve compose.yml from the others - "army/CVOps/services/fronte…" is
// the one piece of the string that carries no information.
//
// Done in JS rather than in CSS on purpose. The CSS trick for a leading ellipsis
// is `direction: rtl`, which also REORDERS the text ("apps/docs/" renders as
// "/apps/docs", which looks like an absolute path and is a different claim), and
// the usual fix for that, `unicode-bidi: plaintext`, resets the resolved
// direction to LTR and puts the ellipsis back at the end - so the two
// properties cancel out. Measured in Chromium: neither alone works, and together
// they do nothing. A character count is deterministic and needs no bidi.
export function tailPath(p: string, max = 28): string {
  return p.length <= max ? p : `…${p.slice(p.length - max)}`;
}

// The default commit message. `docs:` is right for a note and wrong for a
// Dockerfile, and the roots hold both - so the conventional-commit type comes
// from what the file IS. Editable either way; this only has to be a sane start.
export function defaultMessage(path: string, lang: string): string {
  const prose = lang === 'md' || /\.(md|markdown|rst|txt)$/i.test(path);
  return `${prose ? 'docs' : 'chore'}: update ${path}`;
}

// ── what the centre column can DO with a file ────────────────────────────────
//
// Decided from the name, not from the bytes, because the decision is needed
// before (and sometimes instead of) a read: /read answers `content: null` for
// anything binary, so "which preview" cannot wait for the content to arrive.
//
// The image set is EXACTLY safepath.INLINE_TYPES. Anything outside it is served
// as an attachment by the sandbox origin and will not render in an <img> or a
// frame however hard this page tries - SVG most notably, which is deliberately
// an attachment because an inline SVG is a script host. SVG therefore shows as
// highlighted source, which it already did and which is the honest answer.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);

export type Kind = 'text' | 'image' | 'pdf' | 'binary';

export function kindOf(path: string, binary: boolean): Kind {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return binary ? 'binary' : 'text';
}
