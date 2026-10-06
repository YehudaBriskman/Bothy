// The tree model, now that it is built from listings that ARRIVE rather than
// from one flat list.
//
// WHY THIS IS WORTH A TABLE. buildTree used to take the whole root in one array,
// so there was one shape to get right. It now takes a MAP of folder -> that
// folder's direct children and is called again every time a listing lands, which
// adds three ways to be wrong that are all SILENT:
//
//   · a listing that arrives before its parent's (the requests race, and a deep
//     link asks for four folders at once) files its rows under a parent that does
//     not exist yet;
//   · a rebuild that drops the folders already loaded looks exactly like a
//     collapse - the rows are gone and nothing errors;
//   · "nobody has opened this folder" and "this folder is empty" are the same
//     empty `children` array, and showing the wrong one of the two tells a reader
//     a directory is empty when it has simply not been asked for.
//
// It also holds the two things that were DELETED: the per-node `files`/`bytes`
// rollups, and anything that could reinstate them. Those were only computable
// because the client held every file under every folder, which is the eager
// listing this change removed - so a rollup coming back means the recursive walk
// came back with it.

import { buildTree, treeOfPaths } from './lazy-tree-mod.mjs';

let bad = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} ${ok ? g : `want=${w} got=${g}`}`);
};

const f = (path, extra = {}) => ({ path, size: 1, mtime: 1, writable: true, dir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', ...extra });
const d = (path) => ({ path, mtime: 1, writable: true, dir: true });

/** The node at `path`, or undefined. */
const at = (root, path) => {
  if (!path) return root;
  let n = root;
  for (const seg of path.split('/')) {
    n = n.children.find((c) => c.name === seg);
    if (!n) return undefined;
  }
  return n;
};
const kids = (root, path) => (at(root, path)?.children ?? []).map((c) => c.name);

console.log('── one listing, which is what a cold open looks like ───────────────');
const first = new Map([['', [d('docs'), d('src'), f('README.md')]]]);
let t = buildTree(first);
eq('the root holds what the listing described', kids(t, ''), ['docs', 'src', 'README.md']);
// A DIRECTORY NOBODY HAS OPENED IS NOT EMPTY, it is unknown - and the eager tree
// never had to say which, because a folder it did not describe did not exist.
eq('the root itself is loaded', at(t, '').loaded, true);
eq('a folder nobody asked for is NOT loaded', at(t, 'docs').loaded, false);
eq('...and has no children yet', kids(t, 'docs'), []);
eq('a FILE is loaded by definition', at(t, 'README.md').loaded, true);

console.log('\n── a second listing MERGES, and keeps the parents ──────────────────');
const second = new Map(first);
second.set('docs', [d('docs/kb'), f('docs/plan.md')]);
t = buildTree(second);
eq('the new folder has its children', kids(t, 'docs'), ['kb', 'docs/plan.md'.split('/').pop()]);
eq('...and is now loaded', at(t, 'docs').loaded, true);
// THE REGRESSION THIS EXISTS FOR: a rebuild that forgot the earlier listings
// would empty the root, which looks exactly like a collapse and errors nowhere.
eq('the root KEEPS what it already had', kids(t, ''), ['docs', 'src', 'README.md']);
eq('a sibling nobody opened is still unknown', at(t, 'src').loaded, false);

console.log('\n── a listing that arrives before its parent ────────────────────────');
// The requests race: dirsDownTo asks for four folders at once and the answers come
// back in whatever order the network gives them. The deepest one must not be lost.
const outOfOrder = new Map([
  ['a/b/c', [f('a/b/c/deep.md')]],
  ['', [d('a')]],
]);
t = buildTree(outOfOrder);
eq('the deep file is where it belongs', kids(t, 'a/b/c'), ['deep.md']);
eq('its missing ancestors were synthesised', [kids(t, ''), kids(t, 'a'), kids(t, 'a/b')],
  [['a'], ['b'], ['c']]);
// A SYNTHESISED ancestor is not loaded: nothing described it, so its own children
// are still unknown and its chevron has a request to make.
eq('a synthesised ancestor is not marked loaded',
  [at(t, 'a').loaded, at(t, 'a/b').loaded, at(t, 'a/b/c').loaded], [false, false, true]);

console.log('\n── an EMPTY folder is a different answer from an unasked one ───────');
t = buildTree(new Map([['', [d('empty')]], ['empty', []]]));
eq('a listed empty folder has no children', kids(t, 'empty'), []);
eq('...but it IS loaded', at(t, 'empty').loaded, true);

console.log('\n── ordering: directories first, then files, numerically ────────────');
t = buildTree(new Map([['', [f('b.md'), d('z-dir'), f('incident-10.md'), f('incident-02.md'), d('a-dir')]]]));
eq('dirs before files, each sorted', kids(t, ''),
  ['a-dir', 'z-dir', 'b.md', 'incident-02.md', 'incident-10.md']);

console.log('\n── the rollups are GONE, and must not come back ────────────────────');
// `files` and `bytes` per node were computed here so the explorer could answer
// "is this folder over the archive cap?" without walking the subtree. They are
// only computable from a listing that holds every file under every folder - the
// eager one - so a rollup reappearing means the recursive walk reappeared. The
// question is asked at click now, by /dirsize.
t = buildTree(new Map([['', [d('docs'), f('a.md')]], ['docs', [f('docs/b.md')]]]));
// PRESENCE, not value. `JSON.stringify([undefined])` is `[null]`, so comparing the
// values would also pass on a rollup that had come back as null - which is exactly
// the half-reinstated version somebody would write first.
const node = at(t, 'docs');
eq('a directory node has no `files` property', 'files' in node, false);
eq('...and no `bytes` property', 'bytes' in node, false);
eq('the root has neither', ['files' in t, 'bytes' in t], [false, false]);
eq('and the fields a node DOES have are the lazy set', Object.keys(node).sort(),
  ['children', 'dir', 'entry', 'loaded', 'name', 'path']);

console.log('\n── tombstones: a deletion still gets a row ─────────────────────────');
// Deleted files are in /status and CANNOT be in a listing - a listing describes
// what is on disk. They are grafted in so a deletion has a row where files live,
// and they are told apart from a listed file by carrying no entry.
t = buildTree(new Map([['', [d('docs')]], ['docs', [f('docs/here.md')]]]),
  new Set(['docs/gone.md', 'other/also-gone.md']));
eq('the tombstone sits beside its siblings', kids(t, 'docs'), ['gone.md', 'here.md']);
eq('a tombstone carries no entry', at(t, 'docs/gone.md').entry, null);
eq('a listed file still has one', at(t, 'docs/here.md').entry !== null, true);
eq('a tombstone in an unlisted folder gets its folder too',
  kids(t, 'other'), ['also-gone.md']);
// After the real entries, so a path that is BOTH listed and reported deleted keeps
// its real entry rather than being replaced by a stub.
t = buildTree(new Map([['', [f('both.md')]]]), new Set(['both.md']));
eq('a listed path that git calls deleted keeps its entry',
  at(t, 'both.md').entry !== null, true);

console.log('\n── treeOfPaths: for a list that IS the whole answer ────────────────');
// The reader's library (/docs) and anything built from a search result hold a
// complete flat list with no folder left to expand - so every folder it invents is
// loaded, and none of them offers a chevron that leads to a request nobody can
// make.
t = treeOfPaths([f('a/b/one.md'), f('a/two.md'), f('top.md')]);
eq('the folders are synthesised from the paths',
  [kids(t, ''), kids(t, 'a'), kids(t, 'a/b')], [['a', 'top.md'], ['b', 'two.md'], ['one.md']]);
eq('every synthesised folder is loaded',
  [at(t, 'a').loaded, at(t, 'a/b').loaded], [true, true]);
eq('an empty list is an empty tree', treeOfPaths([]).children.length, 0);
// A directory ENTRY in the list is ignored: this builds from file paths, and a
// folder row would be a second source for the same folder.
eq('a directory entry is not a row', kids(treeOfPaths([d('x'), f('x/y.md')]), ''), ['x']);

console.log(`\n${bad ? `${bad} FAILED` : 'all pass'}`);
process.exit(bad ? 1 : 0);
