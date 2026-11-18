// Guards for the Install page: it may not promise anything the repository lists as unproven.
//
//  1. Every sentence the page's own messages say about an unproven topic (arm64, WSL, rootless Docker, SELinux, IPv6,
//     macOS or Windows, k3s, a real update, modules, the larger sizes) must carry a negation or a "built to" /
//     "tested" qualifier. A sentence that sells one of them as working fails here.
//  2. The page renders the proven and unproven lists FROM facts.ts, so a re-proof is one edit and no item is dropped.
//  3. The sudo refusal is stated as "run as your normal user", with the unit-test caveat, never as lab proof.
//  4. Only the linux/amd64 archive is described as run; only Bivvy as installable; the memory gate is the repo's figure.
//  5. If the site has been built, the same sentence rule runs on the rendered page.
//  6. The docs pages that describe the older source-checkout path are the ones that carry the banner.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import allowlist from '../../docs-allowlist.json' with { type: 'json' };
import { MEMORY, MODES, PROVEN, UNPROVEN } from '../facts.ts';
import { en } from '../i18n/en.ts';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, '../..');
const i = en.install;

/** Every string under en.install, calling the functions with sample arguments. */
function strings(node: unknown, out: string[] = [], key = ''): string[] {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'function') {
    if (key !== 'latest' && key !== 'newer' && key !== 'proven')
      out.push((node as (n: number) => string)(MEMORY.gateMiB));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) strings(v, out, k);
  }
  return out;
}

const TOPICS: ReadonlyArray<[string, RegExp]> = [
  ['arm64', /\barm64\b/i],
  ['wsl', /\bWSL\b/],
  ['rootless', /rootless/i],
  ['selinux', /selinux/i],
  ['ipv6', /ipv6/i],
  ['desktop hosts', /\b(macos|darwin|windows)\b/i],
  ['k3s', /\bk3s\b/i],
  ['real update', /\bbothy update\b|\bupdate\b/i],
  ['modules', /\bmodule/i],
  ['larger sizes', /\b(basecamp|cairn)\b/i],
  ['2 GiB host', /\b2 GiB (host|machine)\b/i],
];
const QUALIFIED =
  /\b(not|never|no|nobody|only|refus\w*|unproven|planned|built to|tested|cannot|without|client|--check|checks?|prints?)\b/i;

function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z`*“])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function unqualified(text: string): string[] {
  const bad: string[] = [];
  for (const s of sentences(text)) {
    for (const [name, re] of TOPICS) if (re.test(s) && !QUALIFIED.test(s)) bad.push(`${name}: ${s}`);
  }
  return bad;
}

test('the install page promises nothing about an unproven topic without a qualifier', () => {
  assert.deepEqual(unqualified(strings(i).join('\n')), []);
});

test('the sentence rule catches a promise', () => {
  assert.ok(unqualified('Bothy runs on arm64.').length);
  assert.ok(unqualified('Works on WSL and macOS.').length);
  assert.ok(unqualified('k3s is supported.').length);
  assert.equal(unqualified('Running on arm64 has never been tried.').length, 0);
});

test('the page renders the proven and unproven lists from facts.ts, whole', () => {
  const src = readFileSync(resolve(here, 'Install.tsx'), 'utf8');
  assert.match(src, /UNPROVEN\.map/);
  assert.match(src, /PROVEN\.map/);
  for (const id of UNPROVEN) assert.ok(en.home.proof.not[id], `words for unproven ${id}`);
  for (const id of PROVEN) if (id !== 'install') assert.ok(en.home.proof.shown[id], `words for proven ${id}`);
  // The two lists never share an item.
  for (const id of UNPROVEN) assert.ok(!(PROVEN as readonly string[]).includes(id), id);
});

test('the sudo and root refusal is "run as your normal user", with the unit-test caveat and no lab claim', () => {
  assert.match(i.user.heading, /normal user/i);
  assert.match(i.user.body, /sudo/);
  assert.match(i.user.body, /root/);
  assert.match(i.user.caveat, /unit tests/);
  assert.match(i.user.caveat, /not been tried on a lab machine/);
  assert.doesNotMatch(strings(i.user).join(' '), /\b(proven|lab-proven|shown in the lab)\b/i);
});

test('only linux/amd64 is described as run, only Bivvy as installable, the gate is the repo figure', () => {
  for (const [platform, words] of Object.entries(i.platforms.rows)) {
    if (platform === 'linux/amd64') assert.match(words, /end to end/);
    else assert.match(words, /never run|client/i, platform);
  }
  assert.deepEqual(
    MODES.filter((m) => m.state === 'now').map((m) => m.id),
    ['bivvy'],
  );
  assert.match(i.notSupported.items.join(' '), /Only Bivvy installs/);
  assert.equal(MEMORY.gateMiB, 960);
  assert.match(i.need.memory(MEMORY.gateMiB), /960 MiB/);
});

test('the update line says what was tested and what was not', () => {
  const text = i.later.items.join(' ');
  assert.match(text, /not:\*\* a real update between two real releases/);
  assert.doesNotMatch(text, /\bbothy update\b[^.]*\b(always|safely|will)\b/i);
});

test('if the site is built, the rendered install page obeys the same rule', () => {
  const file = resolve(siteRoot, 'dist/install/index.html');
  if (!existsSync(file)) return;
  const html = readFileSync(file, 'utf8')
    .replace(/<ul class="proof-list proof-not">[\s\S]*?<\/ul>/, '') // the "not shown" list itself
    .replace(/<table[\s\S]*?<\/table>/g, '')
    .replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/g, '')
    .replace(/<\/(p|li|h\d|div|section)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'");
  assert.deepEqual(unqualified(html), []);
});

test('the docs banner is on the pages that describe the source checkout, and only real pages', () => {
  const slugs = allowlist.files.map((f) => f.slug);
  assert.deepEqual([...allowlist.checkoutPath].sort(), ['installing', 'the-cli', 'upgrading']);
  for (const s of allowlist.checkoutPath) assert.ok(slugs.includes(s), s);
  // backups.md stays out: it names a note location of the owner's.
  assert.ok(!allowlist.files.some((f) => f.file.endsWith('backups.md')));
});
