// ── the Control landing: a control-centre home ───────────────────────────────
//
// It replaces a page that said one thing - which systems had something down -
// and said nothing at all on a healthy box. That was honest, and it was also a
// page nobody had a reason to open. This one answers four questions, in the
// order they are asked (apple-design §16: the most important thing is the most
// obvious; hierarchy by order, spacing and contrast):
//
//   1. Is the box all right?            the health strip - six numbers, each a link
//   2. What do I need to do?            Needs attention - one prioritised list
//   3. Where do I go?                   Quick links - every published UI, one click
//   4. What is it doing / what changed? Cluster, Edge and routes, Recent activity
//
// and keeps what the old page had, folded, at the bottom (Services by group).
//
// WHERE EVERY NUMBER COMES FROM, and why the cadences differ:
//
//   services, routers, ports   the app's one shared poll (lib/data.tsx) - the
//                              Settings > Data & refresh interval
//   cluster, edge traffic      Prometheus via lib/metrics.ts - the same interval;
//                              unaudited reads, so they can be asked that often
//   updates status             /-/api/updates/status (viewer) - at most every
//   backups, audit             five minutes, and on Refresh. EVERY read of these
//                              is a line in bothy-ops' admin.log (SECURITY.md §7,
//                              §8), and a ten-second poll would be 8,640 lines a
//                              day per open tab saying only "the tab was open".
//
// ROLES. Nothing is requested before the session answers, and the operator-only
// reads (backups, audit) are never requested for any other session - see
// home.ts gatesFor(), held by checks/control-home.mjs. The edge enforces the
// roles regardless; this only decides what is ASKED.
//
// A source that fails turns its own card to "unavailable" and nothing else: each
// card reads its own Source, and the shared poll already keeps its last good
// answer.

import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { usePortal, needsAttention, healthOf, expectedUp } from '../../lib/data';
import { useDataPrefs } from '../../lib/usePrefs';
import { useOperator } from '../../lib/session';
import { fetchUpdates } from '../../lib/updates';
import { fetchAudit, fetchBackups } from '../../lib/admin';
import { KUBE_NAMESPACES } from '../../lib/kube-actions';
import { Skeleton } from '../../components/states';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { usePolled } from '../../components/control-home/usePolled';
import { loadCluster, loadEdge } from '../../components/control-home/sources';
import { HealthStrip, type Tile } from '../../components/control-home/HealthStrip';
import { AttentionList } from '../../components/control-home/AttentionList';
import { QuickLinks } from '../../components/control-home/QuickLinks';
import { ClusterCard } from '../../components/control-home/ClusterCard';
import { EdgeCard } from '../../components/control-home/EdgeCard';
import { ActivityCard } from '../../components/control-home/ActivityCard';
import { ServiceGroups } from '../../components/control-home/ServiceGroups';
import {
  attentionList, backupSummary, emptyNamespaces, fmtAge, gatesFor, portCollisions, routeCounts, updatesSummary,
  type RouteProblem,
} from './home';
import './controlHome.css';

/** The audited reads: never more often than this, whatever the poll interval. */
const AUDITED_MIN_MS = 5 * 60_000;

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function ControlHome() {
  const { data, refresh } = usePortal();
  const [prefs] = useDataPrefs();
  const { me, loading: sessionLoading } = useOperator();
  const gates = gatesFor(me?.roles ?? null, sessionLoading);
  const [tick, setTick] = useState(0);

  const pollMs = prefs.pollSeconds * 1000;
  const auditedMs = Math.max(pollMs, AUDITED_MIN_MS);
  const cluster = usePolled(loadCluster, { enabled: true, everyMs: pollMs, tick });
  const edge = usePolled(loadEdge, { enabled: true, everyMs: pollMs, tick });
  const updates = usePolled(fetchUpdates, { enabled: gates.updates, everyMs: auditedMs, tick });
  const backups = usePolled(fetchBackups, { enabled: gates.backups, everyMs: auditedMs, tick });
  const audit = usePolled((s) => fetchAudit({ limit: 5 }, s), { enabled: gates.audit, everyMs: auditedMs, tick });

  const now = Math.max(data.at, cluster.at, edge.at, updates.at) || Date.now();

  // ── derived ──────────────────────────────────────────────────────────────
  const counts = useMemo(() => healthOf(data.nodes.filter((n) => !n.hidden)), [data.nodes]);
  const attentionNodes = useMemo(() => needsAttention(data.nodes), [data.nodes]);

  const routeProblems = useMemo<RouteProblem[]>(() => {
    const out: RouteProblem[] = [];
    for (const r of data.routers) if (r.status && r.status !== 'enabled') out.push({ router: r.name, state: 'disabled', status: r.status });
    // Orphan routes, scoped exactly as needsAttention scopes them: a route whose
    // whole system is switched off is that system being off, not a fault.
    for (const n of attentionNodes) {
      if (n.kind !== 'orphan-route' || !n.route) continue;
      if (out.some((p) => p.router === n.route!.router)) continue;
      out.push({ router: n.route.router, state: n.route.provider === 'file' ? 'unknown' : 'no-container' });
    }
    return out;
  }, [data.routers, attentionNodes]);
  const rc = routeCounts(data.routers, routeProblems);

  const us = updates.data ? updatesSummary(updates.data.components) : null;
  const bs = backups.data ? backupSummary(backups.data, now) : null;

  const items = useMemo(() => attentionList({
    down: attentionNodes.filter((n) => n.status === 'down').map((n) => ({ id: n.id, name: n.name, groupTitle: n.groupTitle || n.group })),
    routes: routeProblems,
    collisions: portCollisions(data.ports),
    cluster: cluster.data ? {
      reporting: cluster.data.reporting,
      nodeReady: cluster.data.nodeReady,
      node: cluster.data.node,
      emptyNamespaces: emptyNamespaces(KUBE_NAMESPACES, cluster.data.podsByNs, cluster.data.namespaces),
    } : null,
    updates: us?.facts ?? null,
    backups: bs?.facts ?? null,
  }), [attentionNodes, routeProblems, data.ports, cluster.data, us, bs]);

  const degraded = [
    ...new Set(data.errors.map((e) => e.src.split(' ')[0])),
    ...(cluster.state === 'error' ? ['Cluster metrics'] : []),
    ...(updates.state === 'error' ? ['Updates'] : []),
    ...(backups.state === 'error' ? ['Backups'] : []),
  ];
  const pending = [cluster, updates, backups].some((s) => s.state === 'loading');

  // ── the health strip ─────────────────────────────────────────────────────
  const expected = expectedUp(counts);
  // "Down" in the words and the tone is the needsAttention count - a down
  // container inside a system that is otherwise switched off is that system
  // being off (lib/data.tsx rule 3), so it is named separately, not as a fault.
  const liveDown = attentionNodes.filter((n) => n.status === 'down').length;
  const offDown = counts.down - liveDown;
  const tiles: Tile[] = [
    {
      key: 'services', label: 'Services', to: '/control/services',
      value: <><span className="ch-num">{counts.up}</span><span className="ch-of"> / {expected} up</span></>,
      sub: [
        `${liveDown} down`,
        counts.unknown ? `${counts.unknown} unverified` : '',
        offDown ? `${offDown} failed in switched-off systems` : '',
        counts.stopped ? `${counts.stopped} stopped` : '',
      ].filter(Boolean).join(' · '),
      tone: liveDown ? 'bad' : counts.unknown ? 'unknown' : 'ok',
      toneLabel: liveDown ? 'Some down' : counts.unknown ? 'Some unverified' : 'All up',
    },
  ];
  {
    const c = cluster.data;
    const ready = c ? Object.values(c.readyByNs).reduce((a, b) => a + b, 0) : 0;
    const live = c ? Object.values(c.livePodsByNs).reduce((a, b) => a + b, 0) : 0;
    tiles.push(!c ? {
      key: 'cluster', label: 'Cluster', to: '/control/cluster',
      value: cluster.state === 'loading' ? '…' : 'Unavailable', sub: 'metrics did not answer', tone: 'unknown', toneLabel: 'Unknown',
    } : !c.reporting ? {
      key: 'cluster', label: 'Cluster', to: '/control/cluster', value: 'Off', sub: 'not reporting', tone: 'off', toneLabel: 'Off',
    } : {
      key: 'cluster', label: 'Cluster', to: '/control/cluster',
      value: c.nodeReady ? 'Ready' : 'Not ready',
      sub: `${ready} / ${live} pods ready`,
      tone: !c.nodeReady ? 'bad' : ready < live ? 'warn' : 'ok',
      toneLabel: c.nodeReady ? 'Node ready' : 'Node not ready',
    });
  }
  tiles.push({
    key: 'routes', label: 'Routes', to: '/control/routes',
    value: <><span className="ch-num">{rc.enabled}</span><span className="ch-of"> / {rc.total}</span></>,
    sub: rc.problems ? `enabled · ${rc.problems} need a look` : 'enabled',
    tone: routeProblems.some((p) => p.state === 'disabled') ? 'bad' : rc.problems ? 'warn' : 'ok',
    toneLabel: rc.problems ? 'Needs a look' : 'All enabled',
  });
  if (gates.updates) {
    tiles.push(!us ? {
      key: 'updates', label: 'Updates', to: '/settings/updates',
      value: updates.state === 'loading' ? '…' : 'Unavailable', sub: 'status did not answer', tone: 'unknown', toneLabel: 'Unknown',
    } : {
      key: 'updates', label: 'Updates', to: '/settings/updates',
      value: <><span className="ch-num">{us.available}</span><span className="ch-of"> available</span></>,
      sub: us.available ? `largest: ${us.top}${us.facts.paused.length ? ` · ${us.facts.paused.length} paused` : ''}` : 'everything is current',
      tone: us.facts.paused.length ? 'warn' : us.available ? 'unknown' : 'ok',
      toneLabel: us.facts.paused.length ? 'Paused' : us.available ? 'Updates available' : 'Current',
    });
  }
  if (gates.backups) {
    tiles.push(!bs ? {
      key: 'backup', label: 'Last backup', to: '/settings/backups',
      value: backups.state === 'loading' ? '…' : 'Unavailable', sub: 'inventory did not answer', tone: 'unknown', toneLabel: 'Unknown',
    } : {
      key: 'backup', label: 'Last backup', to: '/settings/backups',
      value: bs.facts.missing ? 'Never' : `${fmtAge(bs.newestAge)} ago`,
      sub: bs.facts.missing ? 'no backup has run' : bs.facts.stale.length ? `${bs.facts.stale.length} set${bs.facts.stale.length === 1 ? '' : 's'} stale` : 'every set is fresh',
      tone: bs.facts.missing || bs.facts.stale.length ? 'warn' : 'ok',
      toneLabel: bs.facts.missing ? 'Never' : bs.facts.stale.length ? 'Stale' : 'Fresh',
    });
  }
  if (gates.updates && updates.data) {
    const last = updates.data.auto?.last ?? null;
    const enabled = updates.data.auto?.enabled ?? false;
    const age = last?.at ? (now - Date.parse(last.at)) / 1000 : null;
    tiles.push({
      key: 'night', label: 'Night job', to: '/settings/updates',
      value: !enabled ? 'Off' : !last ? 'Not run' : last.outcome === 'requested' ? 'Requested' : 'Skipped',
      sub: !last ? (enabled ? 'runs at 03:30' : 'automatic updates are off')
        // The age first: the reason can be a sentence, and the line clamps.
        : [age != null ? `${fmtAge(age)} ago` : '', last.component ?? '', last.reason ?? ''].filter(Boolean).join(' · '),
      tone: !enabled ? 'off' : !last ? 'unknown' : 'ok',
      toneLabel: !enabled ? 'Off' : last ? `Last decision: ${last.outcome}` : 'Not run yet',
    });
  }

  const loading = data.at === 0 && data.fails === 0;

  return (
    <div className="page control-page ch">
      <div className="page-head ch-head">
        <div>
          <h1>Control</h1>
          <p className="page-sub">What is wrong, where to go, and what changed - everything here is live and links onward.</p>
        </div>
        <div className="ch-head-aside">
          {data.at > 0 && <span className="ch-asof">as of {clock(data.at)}</span>}
          <Button
            variant="ghost" size="sm"
            onClick={() => { refresh(); setTick((t) => t + 1); }}
            aria-label="Refresh every card now"
          >
            <Icon icon={RefreshCw} size="sm" />
            Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <div aria-busy="true">
          <span className="sr-only" role="status">Loading the box's state…</span>
          <Skeleton variant="overview" />
        </div>
      ) : (
        <>
          <HealthStrip tiles={tiles} />
          <div className="ch-grid">
            <AttentionList items={items} nodes={data.nodes} canAct={gates.act} degraded={degraded} pending={pending} />
            <QuickLinks nodes={data.nodes} gates={gates} />
            <ClusterCard src={cluster} projects={data.projects} />
            <EdgeCard counts={rc} src={edge} />
            <ActivityCard
              gates={gates} signedIn={!!me} updates={updates} backups={backups} audit={audit} now={now}
            />
          </div>
          <ServiceGroups nodes={data.nodes} attention={attentionNodes} />
        </>
      )}
    </div>
  );
}
