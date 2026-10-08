// The Settings area's registry and its per-browser preferences.
//
// lib/settings-index.ts is what the nav, the breadcrumbs and "Search settings"
// read; pages/settings/routes.tsx is what the router serves. A section in one
// and not the other is a nav entry into the not-found page, or a page nobody can
// find - both silent. lib/prefs.ts feeds hand-editable localStorage into timers,
// attributes and a redirect; every hostile value must come back as a default.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SECTIONS, BLOCKS, GROUPS, searchSettings, hitPath,
} from './settings-index.mjs';
import {
  parseAppearance, parseLayout, parseData, appearanceAttrs, landingRedirect, orderSections,
  togglePrimary, APPEARANCE_DEFAULT, LAYOUT_DEFAULT, DATA_DEFAULT, LANDINGS, KNOWN_KEYS,
  QUICK_TILES, CONTROL_CARDS,
  SETTINGS_GROUPS_KEY, parseOpenGroups, groupOpen, toggleGroup, arriveInGroup,
} from './prefs.mjs';
import { LIVE_PATHS } from './redirects.mjs';

const SRC = process.argv[2];
let fails = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

// ── registry ────────────────────────────────────────────────────────────────
const ids = SECTIONS.map((s) => s.id);
ok(new Set(ids).size === ids.length, 'section ids are unique');
const bids = BLOCKS.map((b) => b.id);
ok(new Set(bids).size === bids.length, 'block ids are unique', bids.filter((b, i) => bids.indexOf(b) !== i).join(','));
ok(BLOCKS.every((b) => ids.includes(b.section)), 'every block names a real section');
ok(SECTIONS.every((s) => GROUPS.some((g) => g.id === s.group)), 'every section names a real group');
ok(SECTIONS.every((s) => BLOCKS.some((b) => b.section === s.id)), 'every section has at least one block');

const routes = readFileSync(join(SRC, 'pages/settings/routes.tsx'), 'utf8');
const routedPairs = [...routes.matchAll(/^\s{2}([a-z]+): ([A-Z]\w+Settings),$/gm)].map((m) => [m[1], m[2]]);
const routed = routedPairs.map((p) => p[0]);
const fileOf = Object.fromEntries([...routes.matchAll(/import \{ (\w+Settings) \} from '\.\/(\w+)';/g)].map((m) => [m[1], m[2]]));
ok(JSON.stringify([...routed].sort()) === JSON.stringify([...ids].sort()),
  'routes.tsx serves exactly the registry\'s sections', routed.join(','));
for (const [s, comp] of routedPairs) {
  const page = readFileSync(join(SRC, `pages/settings/${fileOf[comp]}.tsx`), 'utf8');
  const used = [...page.matchAll(/<SettingBlock\s+id="([a-z-]+)"/g)].map((m) => m[1]);
  const want = BLOCKS.filter((b) => b.section === s).map((b) => b.id);
  ok(JSON.stringify([...used].sort()) === JSON.stringify([...want].sort()),
    `${s}: the page renders exactly its registered blocks`, `page ${used.join(',')} · index ${want.join(',')}`);
}

// ── search ──────────────────────────────────────────────────────────────────
const top = (q) => searchSettings(q)[0];
ok(top('password')?.section.id === 'credentials' || searchSettings('password').some((h) => h.section.id === 'credentials'),
  '"password" finds Credentials');
ok(top('theme')?.block?.id === 'theme', '"theme" puts the Theme block first', top('theme')?.block?.id);
ok(searchSettings('backup').some((h) => h.section.id === 'backups' && h.block === null), '"backup" offers the Backups page itself');
ok(searchSettings('dark mode').some((h) => h.block?.id === 'theme'), 'every word must match, across title and keywords');
ok(searchSettings('zzqq').length === 0 && searchSettings('   ').length === 0, 'nonsense and blanks find nothing');
ok(hitPath({ section: { id: 'data' }, block: { id: 'retention' } }) === '/settings/data?block=retention', 'a block hit is ?block=');
ok(LIVE_PATHS.includes('/settings/:section'), 'LIVE_PATHS knows the section route');

// ── prefs: hostile values become defaults ───────────────────────────────────
for (const raw of [null, '', 'x', '[]', '42', '{"density":"huge","motion":1,"accent":"red","docFont":null}']) {
  ok(JSON.stringify(parseAppearance(raw)) === JSON.stringify(APPEARANCE_DEFAULT), `appearance ${JSON.stringify(raw)} -> default`);
}
ok(Object.values(appearanceAttrs(APPEARANCE_DEFAULT)).every((v) => v === null), 'the default appearance stamps no attribute');
ok(appearanceAttrs({ ...APPEARANCE_DEFAULT, accent: 'violet', density: 'compact' })['data-accent'] === 'violet', 'a chosen accent is stamped');
ok(parseData('{"pollSeconds":0}').pollSeconds === DATA_DEFAULT.pollSeconds, 'a poll of 0 seconds is refused');
ok(parseData('{"pollSeconds":30,"chartRange":"6h"}').pollSeconds === 30, 'a listed poll interval is kept');
ok(parseData('{"chartRange":"1y"}').chartRange === DATA_DEFAULT.chartRange, 'an unknown chart range is refused');
ok(parseLayout('{"landing":"https://evil.example"}').landing === LAYOUT_DEFAULT.landing, 'a landing outside the list is refused');
ok(parseLayout('{"landing":"//evil"}').landing === '/', 'a protocol-relative landing is refused');
ok(JSON.stringify(parseLayout('{"hiddenPanels":["vitals","status",1,"vitals"]}').hiddenPanels) === '["vitals"]',
  'hidden panels are de-duplicated, and the status line cannot be hidden');
ok(LANDINGS.every((l) => LIVE_PATHS.includes(l.path)), 'every landing is a live path');
const L = { ...LAYOUT_DEFAULT, landing: '/control' };
ok(landingRedirect('', L) === '#/control' && landingRedirect('#/', L) === '#/control', 'a bare visit is redirected');
ok(landingRedirect('#/files?root=notes', L) === null, 'a deep link is never redirected');
ok(landingRedirect('', LAYOUT_DEFAULT) === null, 'the default landing redirects nothing');
ok(orderSections([{ key: 'bothy' }, { key: 'projects' }, { key: 'x' }], 'projects-first').map((s) => s.key).join() === 'projects,bothy,x',
  'projects-first reorders, unknown sections stay last');
// ── prefs: the primary tile and the primary card (batch A) ──────────────────
// The failure this guards is silent in both directions: a stored id this build
// no longer draws would leave a strip with a preference and no primary, and an
// id in the list that nothing renders would leave a pin that never lights.
ok(parseLayout(null).primaryTile === null && parseLayout(null).primaryCard === null,
  'no primary is the default, and it is a real state the pages must look right in');
ok(parseLayout('{"primaryTile":"disk"}').primaryTile === 'disk', 'a chosen primary tile survives a reload');
ok(parseLayout('{"primaryCard":"cluster"}').primaryCard === 'cluster', 'a chosen primary card survives a reload');
ok(parseLayout('{"primaryTile":"gpu"}').primaryTile === null, 'a primary tile this build does not draw comes back as none');
ok(parseLayout('{"primaryTile":7,"primaryCard":{}}').primaryTile === null && parseLayout('{"primaryCard":{}}').primaryCard === null,
  'a non-string primary comes back as none');
ok(parseLayout('{"primaryCard":"attention"}').primaryCard === null,
  'the exception list and the quick links are not choosable (they are not things to watch)');
ok(parseLayout(JSON.stringify({ ...LAYOUT_DEFAULT, primaryTile: 'mem', primaryCard: 'edge' })).primaryTile === 'mem',
  'what the page writes is what the next load reads (the round trip)');
ok(togglePrimary('disk', 'disk') === null && togglePrimary('disk', 'cpu') === 'cpu' && togglePrimary(null, 'cpu') === 'cpu',
  'pressing the current primary clears it; pressing another moves it');
// THE WIRE. A list and a page that disagree about an id is the whole failure:
// the preference persists perfectly and reaches nothing.
const qv = readFileSync(join(SRC, 'components/QuickView.tsx'), 'utf8');
const chome = readFileSync(join(SRC, 'pages/control/ControlHome.tsx'), 'utf8');
ok(QUICK_TILES.every((t) => new RegExp(`id="${t.id}"`).test(qv)),
  'every quick-view tile id in prefs.ts is rendered by QuickView.tsx', QUICK_TILES.map((t) => t.id).join(','));
ok(CONTROL_CARDS.every((c) => chome.includes(`pickCard('${c.id}')`)),
  'every control-card id in prefs.ts is handed to a card by ControlHome.tsx', CONTROL_CARDS.map((c) => c.id).join(','));

// ── prefs: which groups of the Settings nav are folded open (2026-10-08) ────
// The default is CLOSED and it is not a constant - it is "the group holding the
// page you are on" - so every failure here is silent on screen. A nav that
// opens everything looks like the old nav; a nav that opens nothing looks like
// a nav with no current page; and a key that collides with SettingBlock's folds
// blocks on four pages with no error anywhere.
ok(SETTINGS_GROUPS_KEY === 'bothy-settings-groups-v1' && SETTINGS_GROUPS_KEY !== 'bothy-settings-nav-v1',
  'the nav groups have their OWN key - bothy-settings-nav-v1 holds block state', SETTINGS_GROUPS_KEY);
for (const raw of [null, '', 'x', '[]', '42', '"box"', '{"box":"yes","you":1,"":true}']) {
  ok(JSON.stringify(parseOpenGroups(raw)) === '{}', `nav groups ${JSON.stringify(raw)} -> no opinion`);
}
ok(JSON.stringify(parseOpenGroups('{"box":true,"you":false,"look":"x"}')) === '{"box":true,"you":false}',
  'only boolean opinions survive the parse');
// The rule itself.
ok(groupOpen({}, 'box', 'box') === true && groupOpen({}, 'you', 'box') === false,
  'with nothing stored, exactly the group holding the page is open');
ok(groupOpen({ you: true }, 'you', 'box') === true && groupOpen({ box: false }, 'box', 'box') === false,
  'a stored opinion beats the default, in both directions');
ok(groupOpen({}, 'you', null) === false,
  'on /settings itself - no section, so no active group - every group is shut');
// The toggle, and the canonicalisation that keeps a non-choice out of the store.
ok(JSON.stringify(toggleGroup({}, 'you', 'box')) === '{"you":true}', 'opening a group away from the page is remembered');
ok(JSON.stringify(toggleGroup({}, 'box', 'box')) === '{"box":false}', 'folding the group you are in is remembered');
ok(JSON.stringify(toggleGroup({ box: false }, 'box', 'box')) === '{}'
  && JSON.stringify(toggleGroup({ you: true }, 'you', 'box')) === '{}',
  'an opinion that has become the default is deleted, not written back');
ok(JSON.stringify(parseOpenGroups(JSON.stringify(toggleGroup({}, 'access', 'box')))) === '{"access":true}',
  'what the nav writes is what the next load reads (the round trip)');
// Arriving. A fold must not swallow the page you just navigated to.
ok(JSON.stringify(arriveInGroup({ box: false }, 'box')) === '{}',
  'navigating into a folded group unfolds it - a search hit always lands somewhere visible');
ok(JSON.stringify(arriveInGroup({ box: false }, 'you')) === '{"box":false}',
  'and leaves every other group exactly as it was');
const kept = { you: true };
ok(arriveInGroup(kept, 'you') === kept && arriveInGroup(kept, null) === kept,
  'nothing to clear returns the SAME object, so the shell writes nothing on a plain render');
// THE WIRE, both halves. A group id the nav cannot name, or a shell that keeps
// the open state per Nav copy, are each invisible until someone uses the drawer.
const shell = readFileSync(join(SRC, 'components/settings/SettingsShell.tsx'), 'utf8');
const navBody = shell.slice(shell.indexOf('function Nav('), shell.indexOf('export function SettingsShell'));
ok(navBody.length > 200 && !/useState|localStorage/.test(navBody),
  'Nav holds no open state of its own - the two copies read the shell\'s', `${navBody.length} chars read`);
ok(/useOpenGroups\(\)/.test(shell) && (shell.match(/<Nav \{\.\.\.nav\}/g) ?? []).length === 2,
  'both the aside and the drawer are handed the one state', `${(shell.match(/<Nav \{\.\.\.nav\}/g) ?? []).length} copies`);
ok(/const uid = useId\(\)/.test(shell) && /\$\{uid\}-p-\$\{g\.id\}/.test(shell),
  'each copy builds its region ids off its own useId - both are in the DOM while the drawer is open');
ok(/arriveInGroup\(groups, activeGroup\)/.test(shell) && /next !== groups/.test(shell),
  'the shell clears a fold on arrival, and only writes when something changed');
// The bug this cost an hour: without the ref the effect runs on every change of
// `groups`, so folding the group you are standing in is undone in the same frame
// and the group springs back open. It looks like a toggle that does not work.
ok(/arrived\.current === activeGroup\) return;/.test(shell) && /arrived\.current = activeGroup;/.test(shell),
  'and it clears it on ARRIVAL only, so folding the group you are in is not undone in the same frame');
const navCss = readFileSync(join(SRC, 'components/settings/settings.css'), 'utf8');
ok(/\.set-nav-gh\[aria-expanded='false'\] \.set-nav-chev/.test(navCss),
  'the chevron turns off aria-expanded, not off a second copy of the open state');

const keys = KNOWN_KEYS.map((k) => k.key);
for (const k of ['portal-theme', 'portal-theme-appearance', 'portal-theme-is-user', 'bothy-reading-v1', 'bothy-collapsed-groups-v1', 'bothy-control-nav-v1']) {
  ok(keys.includes(k), `the existing key ${k} keeps its name`);
}
ok(new Set(keys).size === keys.length, 'no key is listed twice', keys.filter((k, i) => keys.indexOf(k) !== i).join(','));
// Every key this app writes must be listed AND resettable from Settings > Layout
// > Remembered layout, or it is state a person can neither see nor clear.
const layoutPage = readFileSync(join(SRC, 'pages/settings/Layout.tsx'), 'utf8');
for (const k of [SETTINGS_GROUPS_KEY]) {
  const entry = KNOWN_KEYS.find((x) => x.key === k);
  ok(!!entry && entry.resettable, `${k} is in KNOWN_KEYS and says it can be reset`);
  ok(/SETTINGS_GROUPS_KEY/.test(layoutPage), `${k} has a row with a Reset in Remembered layout`);
}

console.log(fails ? `\nFAILED: ${fails}` : '\nsettings: all passed');
process.exit(fails ? 1 : 0);
