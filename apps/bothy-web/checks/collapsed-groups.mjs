// Which service groups you collapsed, and the two ways remembering that goes
// wrong without anybody seeing an error.
//
// The whole feature is per-browser state under one localStorage key, so there is
// nothing to observe from outside a browser and no request to watch fail. Both
// failure modes are silent:
//
//   1. THE KEY MOVES. `group` is `dev.portal.group ?? system` - a display name a
//      label can change - and a panel's key is built from it. File the state
//      under that and the first person to regroup anything, or to rename a
//      compose project, finds every group they had collapsed quietly open again
//      and a dead entry left behind under the old name. This is the same failure
//      the accent seed and the bookmarked URL already have guards for in
//      grouping.mjs; this is the third thing keyed off a group.
//
//   2. THE PRUNE EATS LIVE STATE. Stale keys have to go or the value grows for
//      the life of the browser profile, but the list they are pruned against is
//      not the list on screen. The Services page filters, and the portal polls -
//      so "the groups currently rendered" is empty during an outage and a subset
//      of the truth whenever a filter is on. Prune against either and the page
//      forgets a layout nobody asked it to forget.
//
// Run from checks/run.sh, which compiles discover.ts and collapse.ts next door.
import { groupStorageKey, primaryIdentity } from './discover.mjs';
import {
  COLLAPSED_KEY, parseCollapsed, pruneCollapsed, setAllCollapsed, toggleCollapsed,
} from './collapse.mjs';

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} ${ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// ── the key a collapsed group is filed under ────────────────────────────────
console.log('── a collapsed group stays collapsed when its LABEL moves ───────────');

// The zero-config case, which is every box until somebody sets a label: the
// stable key and the panel key are the same string, so nothing that exists today
// is stored anywhere different.
eq('unregrouped: the stable key IS the panel key',
  groupStorageKey('project:tals', 'tals', ['tals']), 'project:tals');

// THE ONE THAT MATTERS. Two systems displayed as one under `dev.portal.group`.
// The panel key names the display group; the stored key names a member.
eq('merged for display: keyed on an identity, not the new name',
  groupStorageKey('project:data', 'data', ['postgres', 'redis']), 'project:postgres');
eq('...the same one the accent is hashed from',
  groupStorageKey('project:data', 'data', ['postgres', 'redis']),
  `project:${primaryIdentity('data', ['postgres', 'redis'])}`);
// primaryIdentity() takes a SORTED list and does not sort one itself
// (grouping.mjs pins that). groupStorageKey() sorts anyway, because this key is
// the one that gets written to disk - see the comment on it.
eq('...and it does not follow the order docker returned',
  groupStorageKey('project:data', 'data', ['redis', 'postgres']),
  groupStorageKey('project:data', 'data', ['postgres', 'redis']));

// Somebody labels ONE project into a group named after itself plus a friend. The
// group they deliberately named wins, so the key does not jump to the friend.
eq('a group whose key is also a member keeps its own key',
  groupStorageKey('project:postgres', 'postgres', ['postgres', 'redis']), 'project:postgres');

// The two aggregate panels are not display groups at all - they are sections
// that collect every system of a kind, and their keys are constants in
// panels.ts that no label can reach.
eq('the Stack section keys on itself',        groupStorageKey('stack', null, []), 'stack');
eq('the Infrastructure section too',          groupStorageKey('infra', null, []), 'infra');
// A compose project literally named `stack` must not collide with that section.
eq('a project named `stack` is not the Stack section',
  groupStorageKey('project:stack', 'stack', ['stack']), 'project:stack');

// Identity lost entirely - a node with no compose identity at all. The key falls
// back to the display group rather than to `undefined`, which would stringify
// into `project:undefined` and collapse every such group as one.
eq('no identities at all -> the group, never undefined',
  groupStorageKey('project:data', 'data', []), 'project:data');

// ── reading a value somebody else wrote ─────────────────────────────────────
console.log('\n── anything unreadable means "nothing is collapsed" ─────────────────');

eq('nothing stored',                 parseCollapsed(null), []);
eq('an empty string',                parseCollapsed(''), []);
eq('a normal value',                 parseCollapsed('["infra","project:tals"]'), ['infra', 'project:tals']);
eq('written in any order, read back canonical',
  parseCollapsed('["project:tals","infra"]'), ['infra', 'project:tals']);
eq('duplicates collapse',            parseCollapsed('["infra","infra"]'), ['infra']);
eq('non-strings are dropped, the rest survives',
  parseCollapsed('["infra",7,null,{"a":1}]'), ['infra']);
eq('not JSON at all',                parseCollapsed('{oh no'), []);
eq('JSON, but not an array',         parseCollapsed('{"infra":true}'), []);
// The retired `portal-open-groups` held the INVERSE list - which groups were
// OPEN. It parses cleanly here, which is exactly why this module's key is a
// different string; asserted so nobody "tidies up" by reusing the old name.
eq('the retired key is not this key',  COLLAPSED_KEY === 'portal-open-groups', false);

// ── pruning, and the two lists that are not the same list ───────────────────
console.log('\n── a stale key is dropped; a filtered-out one is NOT ────────────────');

const LIVE = ['project:tals', 'project:cvops', 'stack', 'infra'];

eq('a group that no longer exists is dropped',
  pruneCollapsed(['project:tals', 'project:liba'], LIVE), ['project:tals']);
eq('nothing stale, nothing changes',
  pruneCollapsed(['project:tals', 'infra'], LIVE), ['project:tals', 'infra']);
eq('an empty stored list stays empty',
  pruneCollapsed([], LIVE), []);

// THE GUARD. `live` is every group the box HAS, not every group on screen. If a
// caller ever passes the filtered panel list, this is the assertion that goes
// red rather than a person losing their layout while typing in a search box.
eq('AN EMPTY LIVE LIST PRUNES NOTHING - a failed poll is not an empty box',
  pruneCollapsed(['project:tals', 'infra'], []), ['project:tals', 'infra']);

// ── toggling, and "collapse all" under a filter ─────────────────────────────
console.log('\n── the two controls ────────────────────────────────────────────────');

eq('collapsing a group adds it',     toggleCollapsed([], 'infra'), ['infra']);
eq('expanding it removes it',        toggleCollapsed(['infra'], 'infra'), []);
eq('the list stays canonical',       toggleCollapsed(['stack'], 'infra'), ['infra', 'stack']);
eq('collapsing twice is not two entries',
  toggleCollapsed(toggleCollapsed([], 'infra'), 'infra'), []);

eq('collapse all, from nothing',
  setAllCollapsed([], ['project:tals', 'infra'], true), ['infra', 'project:tals']);
eq('expand all clears what it names',
  setAllCollapsed(['project:tals', 'infra'], ['project:tals', 'infra'], false), []);

// The filter case, and the reason setAllCollapsed takes a list at all rather
// than clearing everything: with a filter on, `all` is the two panels you can
// see, and a group that is not on screen must come out the other side exactly as
// it went in - in both directions.
eq('collapse all leaves an off-screen group alone',
  setAllCollapsed(['project:cvops'], ['project:tals'], true), ['project:cvops', 'project:tals']);
eq('EXPAND all does too - it cannot open what you cannot see',
  setAllCollapsed(['project:cvops', 'project:tals'], ['project:tals'], false), ['project:cvops']);
eq('collapse all over an already-collapsed group is idempotent',
  setAllCollapsed(['infra'], ['infra', 'stack'], true), ['infra', 'stack']);

console.log();
console.log(fails ? `${fails} check(s) FAILED` : 'all pass');
process.exit(fails ? 1 : 0);
