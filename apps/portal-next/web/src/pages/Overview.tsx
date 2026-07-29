import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ExternalLink, AlertTriangle, ArrowRight, HardDrive, Clock, Boxes,
  BookOpen, BarChart3, Waypoints, type LucideIcon,
} from 'lucide-react';
import { usePortal, needsAttention } from '../lib/data';
import {
  systemsOf, uiPorts, recentlyStarted, diskVolumes, fmtBytes, fmtAgo,
  type System, type UiLink,
} from '../lib/systems';
import { SystemGroup, type GroupSpec } from '../components/SystemGroup';
import { StatusBar, BarGauge, Sparkline, type Seg, type GaugeRow } from '../components/viz';
import { KNOWN_HOSTS, TYPE_META, type PortalNode, type Status, type ServiceType } from '../lib/discover';
import { serviceLink, systemLink, kindLabelOf } from '../lib/links';
import { Skeleton } from '../components/states';
import { ServiceIcon, StatusIcon } from '../lib/icons';
import './Overview.css';

const STATUS_LABEL: Record<Status, string> = {
  up: 'Up', starting: 'Starting', down: 'Down', unknown: 'Unknown',
};

// A bare colour dot is not a status. StatusIcon does this correctly elsewhere;
// these lists used raw <span className="dot"> with no accessible name at all.
function Dot({ status }: { status: Status }) {
  return (
    <>
      <span className="dot" data-state={status} aria-hidden="true" />
      <span className="sr-only">{STATUS_LABEL[status]}</span>
    </>
  );
}

// A Grafana-style panel: compact header (icon + title + right-aligned meta) over
// a fixed-height body that scrolls internally, so the page never grows unbounded.
function Panel({
  title, meta, Icon, className, children, id,
}: {
  title: string;
  meta?: ReactNode;
  Icon?: LucideIcon;
  className?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className={`ov-panel ${className ?? ''}`} id={id}>
      <header className="ov-panel-head">
        {Icon && <Icon size={14} className="ov-panel-ico" aria-hidden="true" />}
        <h2 className="ov-panel-title">{title}</h2>
        {meta != null && <span className="ov-panel-meta">{meta}</span>}
      </header>
      <div className="ov-panel-body">{children}</div>
    </section>
  );
}

// ── quick links ──────────────────────────────────────────────────────────────
// Borderless. Seven bordered tiles read as seven competing buttons and ate a
// full-width row for a 15px label each; a navigation strip should recede.
// Docs + Grafana are guaranteed anchors and stay first; the rest appear only
// when discovery actually finds them.
interface QuickItem { key: string; label: string; Icon?: LucideIcon; host?: string; primary?: boolean }
const QUICK_ITEMS: QuickItem[] = [
  { key: 'docs', label: 'Docs', Icon: BookOpen, host: 'docs.dev.test', primary: true },
  { key: 'grafana', label: 'Grafana', Icon: BarChart3, host: 'grafana.dev.test', primary: true },
  { key: 'prometheus', label: 'Prometheus' },
  { key: 'dozzle', label: 'Logs' },
  { key: 'portainer', label: 'Portainer' },
  { key: 'traefik', label: 'Traefik', Icon: Waypoints },
  { key: 'kafka', label: 'Kafka UI' },
];

function QuickLinks({ nodes }: { nodes: PortalNode[] }) {
  const links = useMemo(
    () =>
      QUICK_ITEMS.map((item) => {
        const node = nodes.find(
          (n) =>
            n.browsable && n.url &&
            ((n.host && n.host.includes(item.key)) || n.name.toLowerCase().includes(item.key)),
        );
        return { ...item, node, url: node?.url ?? (item.host ? `http://${item.host}` : null), status: node?.status ?? null };
      }).filter((l) => l.url && (l.primary || l.node)),
    [nodes],
  );
  return (
    <nav className="ov-ql" aria-label="Quick links">
      {links.map(({ key, label, Icon, url, status, node, primary }) => (
        <a
          key={key}
          className={`ov-ql-item ${primary ? 'is-primary' : ''}`}
          href={url!}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="ov-ql-ico">
            {node ? <ServiceIcon node={node} size={15} />
              : Icon ? <Icon size={15} strokeWidth={1.9} aria-hidden="true" /> : null}
          </span>
          <span className="ov-ql-label">{label}</span>
          {status && status !== 'up' && <Dot status={status} />}
        </a>
      ))}
    </nav>
  );
}

// ── the hero: one big answer ─────────────────────────────────────────────────
// "Big bold numbers" for the global metric, a part-to-whole bar beneath it, and
// three supporting stats. Everything else on the page is detail behind this.
function Hero({
  up, total, attentionN, systemsN, diskTotal, segs, history, degraded,
}: {
  up: number; total: number; attentionN: number; systemsN: number;
  diskTotal: number | null; segs: Seg[]; history: number[]; degraded: string[];
}) {
  const pct = total ? Math.round((up / total) * 100) : 0;
  return (
    <section className={`ov-hero ${attentionN ? 'is-warn' : ''}`}>
      <div className="ov-hero-main">
        <div className="ov-hero-num">
          <b className="tnum">{up}</b>
          <span className="ov-hero-of">/ {total} services up</span>
        </div>
        <StatusBar segs={segs} height={10} />
        <div className="ov-hero-legend">
          {segs.filter((s) => s.n > 0).map((s) => (
            <span key={s.key} className="ov-hero-leg">
              <span className={`vz-bar-seg seg-${s.key} ov-hero-leg-dot`} aria-hidden="true" />
              {s.n} {s.label}
            </span>
          ))}
        </div>
      </div>

      <dl className="ov-hero-stats">
        <div className={`ov-stat ${attentionN ? 'is-warn' : ''}`}>
          <dt>Needs a look</dt>
          <dd>
            {attentionN ? <a href="#needs-attention">{attentionN}</a> : <span className="ov-stat-ok">none</span>}
          </dd>
        </div>
        <div className="ov-stat">
          <dt>Healthy</dt>
          <dd>{pct}<span className="ov-stat-unit">%</span></dd>
        </div>
        <div className="ov-stat">
          <dt>Systems</dt>
          <dd>{systemsN}</dd>
        </div>
        <div className="ov-stat">
          <dt>Data</dt>
          <dd className="ov-stat-sm">{diskTotal != null ? fmtBytes(diskTotal) : '—'}</dd>
        </div>
        {/* short label on purpose — "Up, this session" clipped to "UP, THIS SESSI…" */}
        <div className="ov-stat ov-stat-spark">
          <dt title="Services up, sampled once per refresh for this session">Trend</dt>
          <dd><Sparkline points={history} label={`services up over the last ${history.length} refreshes`} /></dd>
        </div>
      </dl>

      {degraded.length > 0 && (
        <p className="ov-hero-degraded">
          <AlertTriangle size={13} aria-hidden="true" />
          {degraded.join(' and ')} unreachable — these numbers cover only what is still visible.
        </p>
      )}
    </section>
  );
}

// ── panel bodies ─────────────────────────────────────────────────────────────
function AttentionBody({ nodes }: { nodes: PortalNode[] }) {
  const attention = useMemo(() => needsAttention(nodes), [nodes]);
  if (!attention.length) {
    return (
      <div className="ov-clear">
        <StatusIcon status="up" size={16} /> Everything discovered is up.
      </div>
    );
  }
  return (
    <div className="ov-attention">
      {attention.map((n) => (
        <Link to={serviceLink(n)} className="ov-alert" key={n.id}>
          <span className="ico sm"><ServiceIcon node={n} size={15} /></span>
          <span className="ov-alert-name">{n.name}</span>
          <StatusIcon status={n.status} />
          <span className="ov-alert-why">{n.status === 'down' ? 'down' : kindLabelOf(n).label}</span>
          <ArrowRight size={14} className="ov-alert-arrow" />
        </Link>
      ))}
    </div>
  );
}

// Stack and project UIs in ONE panel — two panels of the same shape competing
// for the same row was the duplication, not the content.
function UiBody({ stack, project }: { stack: UiLink[]; project: UiLink[] }) {
  const [tab, setTab] = useState<'project' | 'stack'>('project');
  const links = tab === 'project' ? project : stack;
  return (
    <div className="ov-ui">
      <div className="seg-toggle ov-ui-seg" role="group" aria-label="Which UIs">
        <button className={tab === 'project' ? 'on' : ''} aria-pressed={tab === 'project'} onClick={() => setTab('project')}>
          Projects <span className="ov-seg-n">{project.length}</span>
        </button>
        <button className={tab === 'stack' ? 'on' : ''} aria-pressed={tab === 'stack'} onClick={() => setTab('stack')}>
          Stack <span className="ov-seg-n">{stack.length}</span>
        </button>
      </div>
      {!links.length ? (
        <p className="ov-uicol-empty">Nothing browsable here.</p>
      ) : (
        <ul className="ov-uilist">
          {links.map((l) => (
            <li key={l.id} className="ov-uirow">
              <Dot status={l.status} />
              <Link className="ov-uirow-name" to={serviceLink({ id: l.id })}>{l.name}</Link>
              <span className="ov-uirow-host">{l.host ?? (l.port != null ? `:${l.port}` : '—')}</span>
              <a className="ov-uirow-open" href={l.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${l.name} in a new tab`}>
                <ExternalLink size={14} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Disk as a COMPARISON, not a list of numbers: every row is a bar against the
// largest, so "what is eating the disk" is answerable without reading.
function DiskBody({ systems, df }: { systems: System[]; df: ReturnType<typeof usePortal>['data']['df'] }) {
  const { rows, orphanRows } = useMemo(() => {
    const vols = diskVolumes(df, systems);
    const bySystem = new Map<string, { system: System; bytes: number; vols: number }>();
    const orphans: GaugeRow[] = [];
    for (const v of vols) {
      if (v.system) {
        const cur = bySystem.get(v.system.key) ?? { system: v.system, bytes: 0, vols: 0 };
        cur.bytes += v.bytes ?? 0;
        cur.vols += 1;
        bySystem.set(v.system.key, cur);
      } else if (v.refCount === 0 && (v.bytes ?? 0) > 0) {
        orphans.push({
          key: v.name, label: <span className="mono">{v.name}</span>, value: v.bytes ?? 0,
          display: fmtBytes(v.bytes), sub: 'no mount', muted: true,
        });
      }
    }
    const rows: GaugeRow[] = [...bySystem.values()]
      .sort((a, b) => b.bytes - a.bytes)
      .map(({ system, bytes, vols }) => ({
        key: system.key,
        label: system.title,
        value: bytes,
        display: fmtBytes(bytes),
        sub: `${vols} vol${vols === 1 ? '' : 's'}`,
        accent: system.accent,
        href: systemLink(system.key),
      }));
    return { rows, orphanRows: orphans };
  }, [systems, df]);

  if (!rows.length && !orphanRows.length) return <p className="ov-uicol-empty">No persistent volumes.</p>;
  // one scale across BOTH sections, so an orphan bar is comparable to a system's
  const max = Math.max(1, ...rows.map((r) => r.value), ...orphanRows.map((r) => r.value));

  return (
    <div className="ov-disk">
      <BarGauge
        rows={rows}
        max={max}
        renderRow={(r, body) => <Link to={r.href!} className="vz-gauge-inner">{body}</Link>}
      />
      {orphanRows.length > 0 && (
        <>
          <div className="ov-disk-sep">
            Unattached <span className="ov-disk-sep-n">{orphanRows.length}</span>
            <span className="ov-disk-sep-hint">mounted by nothing</span>
          </div>
          <BarGauge rows={orphanRows} max={max} />
        </>
      )}
    </div>
  );
}

// What KIND of thing is running here — a distribution the portal could always
// have computed and never showed.
function MixBody({ nodes }: { nodes: PortalNode[] }) {
  const rows = useMemo<GaugeRow[]>(() => {
    const by = new Map<ServiceType, number>();
    for (const n of nodes) if (!n.hidden) by.set(n.serviceType, (by.get(n.serviceType) ?? 0) + 1);
    return [...by.entries()]
      .sort((a, b) => b[1] - a[1] || TYPE_META[a[0]].order - TYPE_META[b[0]].order)
      .map(([t, n]) => ({
        key: t,
        label: TYPE_META[t].label,
        value: n,
        display: String(n),
      }));
  }, [nodes]);
  if (!rows.length) return <p className="ov-uicol-empty">Nothing discovered.</p>;
  return <BarGauge rows={rows} />;
}

function RecentBody({ nodes }: { nodes: PortalNode[] }) {
  const recent = useMemo(() => recentlyStarted(nodes), [nodes]);
  if (!recent.length) return <p className="ov-uicol-empty">No restarts since the box came up.</p>;
  return (
    <div className="ov-feed">
      {recent.map((n) => (
        <Link to={serviceLink(n)} className="ov-feed-item" key={n.id}>
          <span className="ico sm"><ServiceIcon node={n} size={15} /></span>
          <span className="ov-feed-name">{n.name}</span>
          <span className="ov-feed-ago">{fmtAgo(n.uptimeSecs)}</span>
        </Link>
      ))}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
const OPEN_KEY = 'portal-open-groups';
const readOpen = (): Record<string, boolean> => {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '') || {}; } catch { return {}; }
};

export function Overview() {
  const { data } = usePortal();
  const systems = useMemo(() => systemsOf(data.nodes), [data.nodes]);
  const { stack, project } = useMemo(() => uiPorts(data.nodes), [data.nodes]);
  const attentionN = useMemo(() => needsAttention(data.nodes).length, [data.nodes]);
  const bothDown = data.nodes.length === 0 && data.fails > 0;
  const loading = data.at === 0 && data.fails === 0;

  const diskTotal = useMemo(() => {
    const vols = diskVolumes(data.df, systems);
    let sum = 0; let any = false;
    for (const v of vols) if (v.bytes != null) { sum += v.bytes; any = true; }
    return any ? sum : null;
  }, [systems, data.df]);

  const counts = useMemo(() => {
    let up = 0, down = 0, starting = 0, unknown = 0;
    for (const n of data.nodes) {
      if (n.status === 'up') up++;
      else if (n.status === 'down') down++;
      else if (n.status === 'starting') starting++;
      else unknown++;
    }
    return { up, down, starting, unknown };
  }, [data.nodes]);

  const segs: Seg[] = [
    { key: 'up', n: counts.up, label: 'up' },
    { key: 'starting', n: counts.starting, label: 'starting' },
    { key: 'down', n: counts.down, label: 'down' },
    { key: 'unknown', n: counts.unknown, label: 'unknown' },
  ];

  const degraded = useMemo(
    () => [...new Set(data.errors.map((e) => e.src.split(' ')[0]))],
    [data.errors],
  );

  // Projects individually (few, and they are what the box is for); the shared
  // stack and the plumbing roll up to one card each.
  const groups = useMemo<GroupSpec[]>(() => {
    const of = (k: System['kind']) => systems.filter((s) => s.kind === k);
    return [
      { key: 'project', title: 'Projects', hint: 'what this box is for', systems: of('project') },
      { key: 'stack', title: 'Stack', hint: 'shared dev services', systems: of('stack') },
      { key: 'infra', title: 'Infrastructure', hint: 'the edge and plumbing', systems: of('infra') },
    ].filter((g) => g.systems.length > 0);
  }, [systems]);

  // Projects open by default; the rest stay folded until asked for. Persisted so
  // the page opens the way you left it.
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({ project: true, ...readOpen() }));
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });

  const floorLinks = KNOWN_HOSTS.map(([host, name]) => ({ id: host, name, url: `http://${host}` }));

  return (
    <div className="overview">
      {bothDown && (
        <div className="state err ov-offline">
          <h4>Can't reach the APIs</h4>
          <p>Showing known service names only — live status, ports and projects are unavailable. The links below still work if the services do.</p>
          <div className="ov-quick">
            {floorLinks.map((n) => (
              <a key={n.id} className="ov-quick-item" href={n.url} target="_blank" rel="noopener noreferrer">
                <span className="ov-quick-name">{n.name}</span>
                <ExternalLink size={14} className="ov-quick-ext" />
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="ov-body">
        <div className="ov-topline">
          <h1 className="sr-only">Overview</h1>
          <QuickLinks nodes={data.nodes} />
        </div>

        {loading ? (
          <Skeleton />
        ) : (
          <>
            <Hero
              up={counts.up}
              total={data.nodes.length}
              attentionN={attentionN}
              systemsN={systems.length}
              diskTotal={diskTotal}
              segs={segs}
              history={data.history}
              degraded={degraded}
            />

            <section className="ov-groups" aria-label="Systems">
              {groups.map((g) => (
                <SystemGroup key={g.key} group={g} open={!!open[g.key]} onToggle={() => toggle(g.key)} />
              ))}
            </section>

            <div className="ov-dash">
              <Panel
                id="needs-attention"
                title="Needs attention"
                Icon={AlertTriangle}
                className={attentionN ? 'is-warn' : ''}
                meta={attentionN ? `${attentionN}` : 'clear'}
              >
                <AttentionBody nodes={data.nodes} />
              </Panel>

              <Panel title="Open a UI" Icon={ExternalLink} meta={stack.length + project.length}>
                <UiBody stack={stack} project={project} />
              </Panel>

              <Panel title="Data & disk" Icon={HardDrive} meta={data.df ? fmtBytes(diskTotal) : 'no sizes'}>
                <DiskBody systems={systems} df={data.df} />
              </Panel>

              <Panel title="Service mix" Icon={Boxes} meta={data.nodes.length}>
                <MixBody nodes={data.nodes} />
              </Panel>

              <Panel title="Recent activity" Icon={Clock}>
                <RecentBody nodes={data.nodes} />
              </Panel>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
