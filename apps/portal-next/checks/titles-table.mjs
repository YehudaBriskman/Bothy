// What the reader calls a document - run with ./checks/run.sh
//
// WHY THIS EXISTS. The reader's side panel lists titles derived from filenames
// (docs/plans/reading-first.md §3, pages/files/titles.ts). A wrong title is a
// quiet defect: nothing errors, the list still renders, and the reader simply
// does not find the note they were looking for because it is filed under a word
// they would not have guessed. The failure is in the reader's head, not in a log.
//
// The cases below are REAL paths from the two documentation roots, so the table
// doubles as the evidence for the decision the plan defers - whether prettified
// filenames are good enough, or whether /tree needs a `titles=1` variant that
// reads each file's first heading. The `heading` column is what the file's own
// `# ` line says today; where it differs from the title, that difference is the
// argument for the endpoint, and it is written down rather than remembered.

import { isProse, titleOf } from './titles.mjs';

let bad = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)}${ok ? '' : ` want=${JSON.stringify(want)} got=${JSON.stringify(got)}`}`);
};

console.log('── a filename is already a title ───────────────────────');

// The ordinary case, and the reason the cheap version is worth shipping: whoever
// named these files was writing the title.
for (const [path, want] of [
  ['docs/brand/foundations/shape-and-elevation.md', 'Shape and elevation'],
  ['docs/brand/patterns/data-display.md', 'Data display'],
  ['docs/kb/editor-drafts.md', 'Editor drafts'],
  ['network/tailnet-troubleshooting.md', 'Tailnet troubleshooting'],
  ['docs/plans/first-party-stack.md', 'First party stack'],
  ['docs/kb/always-on.md', 'Always on'],
]) check(path, titleOf(path), want);

console.log('\n── acronyms are not sentence-cased ─────────────────────');

// The one class of output that is visibly, embarrassingly wrong without a table:
// "Dns" and "Metadata and seo" read as typos rather than as titles.
for (const [path, want] of [
  ['network/dns.md', 'DNS'],
  ['machine/ssh.md', 'SSH'],
  ['machine/wsl.md', 'WSL'],
  ['docs/brand/quality/metadata-and-seo.md', 'Metadata and SEO'],
  ['docs/brand/quality/pwa-and-manifest.md', 'PWA and manifest'],
  ['docs/brand/quality/qa-and-verification.md', 'QA and verification'],
  ['stack/kubernetes.md', 'Kubernetes'],
]) check(path, titleOf(path), want);

console.log('\n── SHOUTING FILENAMES stop shouting ────────────────────');

// A top-level doc is named in caps by convention. Twenty of them in a list is
// the list shouting at the reader, so the convention is dropped - except for the
// handful of names that ARE the convention.
for (const [path, want] of [
  ['docs/ARCHITECTURE.md', 'Architecture'],
  ['CODE_OF_CONDUCT.md', 'Code of conduct'],
  ['.github/PULL_REQUEST_TEMPLATE.md', 'Pull request template'],
  ['docs/brand/CHECKLIST.md', 'Checklist'],
  ['README.md', 'README'],
  ['docs/kb/README.md', 'README'],
  ['LICENSE', 'LICENSE'],
]) check(path, titleOf(path), want);

console.log('\n── a dated note keeps its date ─────────────────────────');

// The incident notes are found BY their date. Folding it into the sentence
// ("2026 08 08 WSL node…") loses the one thing they are sorted and remembered by.
for (const [path, want] of [
  ['docs/kb/incidents/2026-08-01-ethernet-ndis.md', '2026-08-01 · Ethernet ndis'],
  ['docs/kb/incidents/2026-08-08-wsl-node-large-packet-blackhole.md',
   '2026-08-08 · WSL node large packet blackhole'],
]) check(path, titleOf(path), want);

console.log('\n── only the basename is read ───────────────────────────');

// The folder is shown separately by the index. Folding it in here would title
// every README after its directory and make four of them look like four
// different documents when they are the same kind of document in four places.
check('the folder is not part of the title',
  titleOf('docs/brand/foundations/colour.md'), titleOf('colour.md'));
check('a dotted stem keeps its first part', titleOf('a.b.md'), 'A b');

console.log('\n── what counts as prose ────────────────────────────────');

// The claim `isProse` makes is "a person reads this end to end", not "this is
// text". A .yml is text and nobody reads one for pleasure - and if this ever
// widened to include them, the "prose first" ordering would stop meaning
// anything and the index would silently become the Explorer again.
for (const [path, want] of [
  ['docs/kb/access.md', true],
  ['a.markdown', true],
  ['requirements.txt', true],
  ['x.rst', true],
  ['compose.yml', false],
  ['app.py', false],
  ['policy.toml', false],
  ['Dockerfile', false],
  ['justfile', false],
  ['logo.svg', false],
]) check(`${path} is ${want ? '' : 'not '}prose`, isProse(path), want);

console.log('\n── where a filename is NOT enough ──────────────────────');

// NOT failures - these are the measured limit of the cheap version, recorded so
// the decision in reading-first.md §3 ("add /tree?titles=1 only if the titles are
// actually wrong often enough to notice") is made from evidence rather than from
// memory. In every case the title is CORRECT and INCOMPLETE: the document's own
// heading is the filename plus a subtitle. That is a subtitle problem, and a
// subtitle is not what the index has room for.
const SUBTITLED = [
  ['docs/kb/runbook-cant-reach.md', 'RUNBOOK - "I can\'t reach the dev stack"'],
  ['docs/kb/access.md', 'Access - every way into the dev box, and why the obvious ones fail'],
  ['docs/kb/topology.md', 'Topology - machines, users, addresses'],
  ['docs/kb/lessons.md', 'Lessons - principles paid for in real debugging time'],
];
const firstWord = (s) => (s.toLowerCase().match(/[a-z0-9]+/) ?? [''])[0];
for (const [path, heading] of SUBTITLED) {
  const t = titleOf(path);
  // The assertion is narrow and it is the one that matters: the title and the
  // heading OPEN ON THE SAME WORD, so the filename is naming the same subject
  // and what it is missing is only the tail. The day one of these stops agreeing
  // is the day the filename names something else, and THAT is the signal to
  // build /tree?titles=1 - not a general feeling that headings are nicer.
  check(`${path} names the same subject`, firstWord(t), firstWord(heading));
  console.log(`      ${t}  ·  heading: ${heading}`);
}

console.log(bad ? `\n${bad} FAILED` : '\nall pass');
process.exit(bad ? 1 : 0);
