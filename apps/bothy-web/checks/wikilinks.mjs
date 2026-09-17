// `[[dns]]` has to find the right document, and the interesting cases are the
// ones where more than one answer exists.
//
// WHY THIS IS WORTH A TABLE. A wikilink carries no directory and no extension,
// so resolving one is a search, and a search has a precedence order. Get that
// order wrong and the failure is not an error - it is a link that opens the
// WRONG note, which nobody reports as a bug because it looks like it worked.
//
// The order under test, from resolveWikiIn's own comment: exact path, then
// +.md, then /index.md, then by basename. Basename is last because it is the
// one people write most and the only one that can be ambiguous.

import { resolveWikiIn } from './wikilinks-mod.mjs';

let bad = 0;
const eq = (label, got, want) => {
  const g = got ? got.path + got.frag : String(got);
  const ok = g === want;
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} ${ok ? g : `want=${want} got=${g}`}`);
};

// A tree with every collision the real one has: a name that exists at two
// depths, a folder with an index, and a file whose name is a prefix of another.
const TREE = [
  'README.md',
  'network/dns.md',
  'network/index.md',
  'machine/dns.md',
  'machine/tooling.md',
  'docs/kb/access.md',
  'docs/kb/runbook-cant-reach.md',
  'notes/DNS.MD',
  'scripts/backup.sh',
];

console.log('── the resolution order ────────────────────────────────────────────');
eq('an exact path wins', resolveWikiIn(TREE, 'network/dns.md'), 'network/dns.md');
eq('a path without its extension', resolveWikiIn(TREE, 'network/dns'), 'network/dns.md');
eq('a folder resolves to its index', resolveWikiIn(TREE, 'network'), 'network/index.md');
eq('a bare name, by basename', resolveWikiIn(TREE, 'tooling'), 'machine/tooling.md');
eq('a leading slash is not an escape hatch', resolveWikiIn(TREE, '/network/dns'), 'network/dns.md');

console.log('\n── ambiguity, resolved the same way every time ─────────────────────');
// dns.md exists twice. The answer must not depend on the order the tree was
// listed in, so it is the shallowest path and then alphabetical.
eq('the shallowest match wins', resolveWikiIn(TREE, 'dns'), 'machine/dns.md');
eq('...and again with the tree reversed', resolveWikiIn([...TREE].reverse(), 'dns'), 'machine/dns.md');
// An EXACT path must never lose to a basename match somewhere shallower.
eq('an exact match beats a shallower basename', resolveWikiIn(TREE, 'network/dns.md'), 'network/dns.md');

console.log('\n── fragments and case ──────────────────────────────────────────────');
eq('a fragment is carried, not resolved', resolveWikiIn(TREE, 'dns#ttl'), 'machine/dns.md#ttl');
eq('a fragment on an exact path', resolveWikiIn(TREE, 'network/dns#ttl'), 'network/dns.md#ttl');
// Somebody writing [[DNS]] about a file called dns.md means that file.
eq('basename matching ignores case', resolveWikiIn(TREE, 'ACCESS'), 'docs/kb/access.md');
eq('...including the extension', resolveWikiIn(['a/Thing.Md'], 'thing'), 'a/Thing.Md');

console.log('\n── what must NOT resolve ───────────────────────────────────────────');
eq('a name nothing matches', resolveWikiIn(TREE, 'nonexistent'), 'null');
eq('an empty target', resolveWikiIn(TREE, ''), 'null');
eq('a bare fragment names no document', resolveWikiIn(TREE, '#heading'), 'null');
// A wikilink is for documents. A shell script is not one, and resolving to it
// would put a button on a page that opens a file the reader cannot read.
eq('a non-document is not found by basename', resolveWikiIn(TREE, 'backup'), 'null');

console.log(`\n${bad ? `${bad} FAILED` : 'all pass'}`);
process.exit(bad ? 1 : 0);
