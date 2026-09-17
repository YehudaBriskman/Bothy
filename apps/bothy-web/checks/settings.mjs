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
  APPEARANCE_DEFAULT, LAYOUT_DEFAULT, DATA_DEFAULT, LANDINGS, KNOWN_KEYS,
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
const keys = KNOWN_KEYS.map((k) => k.key);
for (const k of ['portal-theme', 'portal-theme-appearance', 'portal-theme-is-user', 'bothy-reading-v1', 'bothy-collapsed-groups-v1', 'bothy-control-nav-v1']) {
  ok(keys.includes(k), `the existing key ${k} keeps its name`);
}

console.log(fails ? `\nFAILED: ${fails}` : '\nsettings: all passed');
process.exit(fails ? 1 : 0);
