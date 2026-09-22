// The Control landing's pure logic - run with ./checks/run.sh
//
// pages/control/home.ts decides two things that fail silently: the ORDER of
// "Needs attention" (a paused update above a down service reads as a healthy box
// with a chore), and which operator-only sources a session REQUESTS (a viewer's
// tab asking for the backup inventory is a refused line in admin.log and a card
// that was never theirs to see). Both get truth tables.

import {
  attentionList, gatesFor, NO_GATES, portCollisions, routeCounts, backupSummary, updatesSummary,
  emptyNamespaces, severityCounts, fmtAge, BACKUP_STALE_SECONDS,
} from './control-home-mod.mjs';
import { uiName, productCase, productOf } from './ui-names-mod.mjs';

let bad = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(66)}${ok ? '' : ` want=${JSON.stringify(want)} got=${JSON.stringify(got)}`}`);
};

// ── role gating ──────────────────────────────────────────────────────────────
check('still loading: nothing is requested', gatesFor(['viewer', 'operator'], true), NO_GATES);
check('signed out: nothing is requested', gatesFor(null, false), NO_GATES);
check('no Bothy role: nothing is requested', gatesFor(['default-roles-devbox'], false), NO_GATES);
check('viewer: updates only, no backups, no audit, no verbs',
  gatesFor(['viewer'], false), { updates: true, backups: false, audit: false, act: false });
check('editor alone reads nothing extra', gatesFor(['editor'], false), NO_GATES);
check('operator: everything', gatesFor(['viewer', 'operator'], false), { updates: true, backups: true, audit: true, act: true });
check('operator without viewer still reads updates (operator implies it)',
  gatesFor(['operator'], false), { updates: true, backups: true, audit: true, act: true });
check('shell alone grants no card', gatesFor(['shell'], false), NO_GATES);

// ── the attention list: ordering ─────────────────────────────────────────────
const EMPTY = { down: [], routes: [], collisions: [], cluster: null, updates: null, backups: null };
check('nothing wrong: empty list (the page says All clear)', attentionList(EMPTY), []);

const all = attentionList({
  down: [{ id: 'b-svc', name: 'zeta', groupTitle: 'Tals' }, { id: 'a-svc', name: 'alpha', groupTitle: 'CVOps' }],
  routes: [
    { router: 'tilt@file', state: 'unknown' },
    { router: 'old@docker', state: 'no-container' },
    { router: 'broken@file', state: 'disabled', status: 'disabled' },
  ],
  collisions: [{ port: '8080/tcp', containers: ['a', 'b'] }],
  cluster: { reporting: true, nodeReady: false, node: 'thales-scc', emptyNamespaces: ['thales-dev'] },
  updates: { waiting: [{ id: 'traefik', title: 'Traefik', level: 'patch' }], paused: [{ id: 'loki', title: 'Loki', reason: 'rolled back' }] },
  backups: { stale: [{ name: 'postgres', ageSeconds: 3 * 86400 }], missing: false },
});
check('order: critical, then warning, then notice - each by kind rank, then name',
  all.map((i) => i.kind + ':' + i.subject),
  [
    'service-down:alpha', 'service-down:zeta',
    'cluster-node:thales-scc',
    'router-disabled:broken',
    'port-collision:8080/tcp',
    'backup-stale:postgres',
    'route-orphan:old',
    'namespace-empty:thales-dev',
    'update-paused:Loki',
    'route-unverified:tilt',
    'update-waiting:1 update',
  ]);
check('severity counts', severityCounts(all), { critical: 5, warning: 4, notice: 2 });
check('a down service carries its node id (the row draws Open and restart)', all[0].nodeId, 'a-svc');
check('a down service links to its service page', all[0].to, '/control/services/a-svc');
check('an empty namespace links to the cluster page on that namespace', all.find((i) => i.kind === 'namespace-empty').to, '/control/cluster?ns=thales-dev');
check('every link is an in-app route under a real section',
  all.every((i) => /^\/(control|settings)\//.test(i.to)), true);
check('input order does not change output order (stable across polls)',
  attentionList({ ...EMPTY, down: [{ id: 'x', name: 'b', groupTitle: 'g' }, { id: 'y', name: 'a', groupTitle: 'g' }] }).map((i) => i.subject),
  attentionList({ ...EMPTY, down: [{ id: 'y', name: 'a', groupTitle: 'g' }, { id: 'x', name: 'b', groupTitle: 'g' }] }).map((i) => i.subject));

// ── the attention list: what is and is not a finding ─────────────────────────
check('a Ready node is not a finding',
  attentionList({ ...EMPTY, cluster: { reporting: true, nodeReady: true, node: 'n', emptyNamespaces: [] } }), []);
check('a cluster that is not reporting says nothing (unknown is not a fault)',
  attentionList({ ...EMPTY, cluster: { reporting: false, nodeReady: false, node: null, emptyNamespaces: ['thales-dev'] } }), []);
check('no backups ever: one row, not one per set',
  attentionList({ ...EMPTY, backups: { stale: [], missing: true } }).map((i) => i.what), ['no backup has ever run']);
check('waiting updates fold into one row naming at most three',
  attentionList({ ...EMPTY, updates: { paused: [], waiting: ['A', 'B', 'C', 'D'].map((t) => ({ id: t, title: t, level: 'minor' })) } })
    .map((i) => [i.subject, i.what]),
  [['4 updates', 'waiting for approval: A, B, C, …']]);
check('backups null (viewer) produces no backup row even if stale elsewhere',
  attentionList({ ...EMPTY, backups: null }).length, 0);

// ── summaries ────────────────────────────────────────────────────────────────
check('port collision needs two distinct containers',
  portCollisions([
    { hostPort: 8080, proto: 'tcp', container: 'a' },
    { hostPort: 8080, proto: 'tcp', container: 'a' },
    { hostPort: 9000, proto: 'tcp', container: 'b' },
    { hostPort: 9000, proto: 'tcp', container: 'c' },
    { hostPort: 9000, proto: 'udp', container: 'd' },
  ]),
  [{ port: '9000/tcp', containers: ['b', 'c'] }]);
check('route counts: unverified host processes are not problems',
  routeCounts([{ name: 'a' }, { name: 'b', status: 'enabled' }, { name: 'c', status: 'disabled' }],
    [{ router: 'c', state: 'disabled' }, { router: 't', state: 'unknown' }]),
  { total: 3, enabled: 2, problems: 1 });

const NOW = Date.parse('2026-09-22T12:00:00Z');
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const bs = backupSummary({ present: true, sets: [
  { name: 'postgres', managed: true, newest: { at: iso(9) } },
  { name: 'loki', managed: true, newest: { at: iso(60) } },
  { name: 'old-thing', managed: false, newest: { at: iso(900) } },
  { name: 'env', managed: true, newest: null },
] }, NOW);
check('backup: newest age is the freshest managed set', Math.round(bs.newestAge / 3600), 9);
check('backup: stale = managed and older than two days, or never written',
  bs.facts.stale.map((s) => s.name), ['loki', 'env']);
check('backup: unmanaged sets are never stale (nothing rotates them)', bs.facts.stale.some((s) => s.name === 'old-thing'), false);
check('backup: the threshold is two days', BACKUP_STALE_SECONDS, 172800);
check('backup: no ~/backups at all', backupSummary({ present: false, sets: [] }, NOW).facts, { stale: [], missing: true });

const us = updatesSummary([
  { id: 'traefik', title: 'Traefik', level: 'patch', effectiveChannel: 'auto', paused: null },
  { id: 'postgres', title: 'Postgres', level: 'major', effectiveChannel: 'manual', paused: null },
  { id: 'grafana', title: 'Grafana', level: 'minor', effectiveChannel: 'notify', paused: null },
  { id: 'loki', title: 'Loki', level: null, effectiveChannel: null, paused: { reason: 'rolled back' } },
]);
check('updates: available counts every component with a newer version', us.available, 3);
check('updates: top level is the largest step', us.top, 'major');
check('updates: auto updates do not wait for a person', us.facts.waiting.map((w) => w.id), ['postgres', 'grafana']);
check('updates: a pause is reported whether or not an update is on offer', us.facts.paused.map((p) => p.id), ['loki']);
check('updates: nothing on offer', updatesSummary([]), { available: 0, top: null, facts: { waiting: [], paused: [] } });

check('empty namespaces: in scope, exists, zero pods',
  emptyNamespaces(['thales-dev', 'thales-pre-prod', 'thales-gone'], { 'thales-pre-prod': 7 }, ['thales-dev', 'thales-pre-prod', 'kube-system']),
  ['thales-dev']);

check('age formatting', [fmtAge(30), fmtAge(600), fmtAge(9 * 3600), fmtAge(3 * 86400), fmtAge(null)], ['30s', '10m', '9h', '3d', 'unknown']);

// ── what a UI link is called (lib/ui-names.ts, via uiPorts) ────────────────
// The four names this box actually showed on 2026-09-22, then the edges.
check('a proxied UI takes its system title: Oauth2 Proxy Headlamp -> Headlamp',
  uiName('Oauth2 Proxy Headlamp', 'Headlamp', 1), 'Headlamp');
check('a project-owned UI takes its system title: Manifests · Sonarqube -> SonarQube',
  uiName('Manifests · Sonarqube', 'SonarQube', 1), 'SonarQube');
check('several UIs in one system keep the service name, product-cased: Victoriametrics',
  uiName('Victoriametrics', 'Monitoring · Grafana', 5), 'VictoriaMetrics');
check('... and Cadvisor -> cAdvisor', uiName('Cadvisor', 'Monitoring · Grafana', 5), 'cAdvisor');
check('several UIs: a plain name is untouched (Grafana)', uiName('Grafana', 'Monitoring · Grafana', 5), 'Grafana');
check('a placed "Area · Product" title lends only the product: Identity · Keycloak -> Keycloak',
  uiName('Keycloak', 'Identity · Keycloak', 1), 'Keycloak');
check('no title (the residue group) keeps the service name', uiName('Thales E2e Cov Pg', null, 1), 'Thales E2e Cov Pg');
check('productCase fixes each part of a compound name', productCase('Manifests · Sonarqube'), 'Manifests · SonarQube');
check('productOf of a one-part title is the title', productOf('Headlamp'), 'Headlamp');

console.log(`\n  ${bad ? `${bad} FAILED` : 'all pass'}`);
process.exit(bad ? 1 : 0);
