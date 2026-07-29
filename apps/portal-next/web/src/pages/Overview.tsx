import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ExternalLink, AlertTriangle, ArrowRight, Search, X, HardDrive, Clock, Boxes,
  BookOpen, BarChart3, Waypoints, type LucideIcon,
} from 'lucide-react';
import { usePortal, needsAttention } from '../lib/data';
import {
  systemsOf, runningSystems, dataOnlySystems, uiPorts, recentlyStarted,
  systemDiskBytes, volumeSize, fmtBytes, fmtAgo,
  type System, type UiLink,
} from '../lib/systems';
import { useFavorites, favFirst } from '../lib/favorites';
import { SystemCard } from '../components/SystemCard';
import { KNOWN_HOSTS, type PortalNode } from '../lib/discover';
import { serviceLink } from '../lib/links';
import { Reveal } from '../components/Reveal';
import { ServiceIcon, StatusIcon } from '../lib/icons';
import './Overview.css';

// A Grafana-style panel: compact header (icon + title + right-aligned meta) over
// a fixed-height body that scrolls internally, so the page never grows unbounded.
function Panel({
  title, meta, Icon, className, children,
}: {
  title: string;
  meta?: ReactNode;
  Icon?: LucideIcon;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`ov-panel ${className ?? ''}`}>
      <header className="ov-panel-head">
        {Icon && <Icon size={14} className="ov-panel-ico" aria-hidden="true" />}
        <h2 className="ov-panel-title">{title}</h2>
        {meta != null && <span className="ov-panel-meta">{meta}</span>}
      </header>
      <div className="ov-panel-body">{children}</div>
    </section>
  );
}

// ── 1. Quick links — exactly three primary anchors ───────────────────────────
interface QuickItem { key: string; label: string; Icon: LucideIcon; host: string; }
const QUICK_ITEMS: QuickItem[] = [
  { key: 'docs', label: 'Docs', Icon: BookOpen, host: 'docs.dev.test' },
  { key: 'grafana', label: 'Grafana', Icon: BarChart3, host: 'grafana.dev.test' },
  { key: 'traefik', label: 'Traefik', Icon: Waypoints, host: 'traefik.dev.test' },
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
        return { ...item, url: node?.url ?? `http://${item.host}`, status: node?.status ?? null };
      }),
    [nodes],
  );
  return (
    <div className="ov-ql">
      {links.map(({ key, label, Icon, url, status }) => (
        <a key={key} className="ov-ql-item" href={url} target="_blank" rel="noopener noreferrer">
          <span className="ov-ql-ico"><Icon size={19} strokeWidth={1.9} aria-hidden="true" /></span>
          <span className="ov-ql-label">{label}</span>
          {status && <span className="dot ov-ql-dot" data-state={status} />}
          <ExternalLink size={14} className="ov-ql-ext" aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}

// ── 2. Systems grid — the centrepiece ────────────────────────────────────────
type Seg = 'all' | 'clean' | 'issues';

function SystemsGrid({ systems }: { systems: System[] }) {
  const { favs, isFav, toggle } = useFavorites();
  const [q, setQ] = useState('');
  const [seg, setSeg] = useState<Seg>('all');

  const running = useMemo(() => runningSystems(systems), [systems]);
  const needle = q.trim().toLowerCase();
  const matchText = (s: System) => !needle || `${s.title} ${s.key}`.toLowerCase().includes(needle);

  const textMatched = running.filter(matchText);
  const cleanN = textMatched.filter((s) => s.down === 0).length;
  const issuesN = textMatched.filter((s) => s.down > 0).length;

  const matchSeg = (s: System) => (seg === 'all' ? true : seg === 'clean' ? s.down === 0 : s.down > 0);
  const shown = favFirst(textMatched.filter(matchSeg), (s) => s.key, favs);
  const pinned = running.filter((s) => favs.has(s.key)).length;

  const SEGS: { value: Seg; label: string; n: number }[] = [
    { value: 'all', label: 'All', n: textMatched.length },
    { value: 'clean', label: 'Running clean', n: cleanN },
    { value: 'issues', label: 'Has issues', n: issuesN },
  ];

  return (
    <section className="ov-systems">
      <div className="ov-systems-head">
        <Boxes size={16} className="ov-panel-ico" aria-hidden="true" />
        <h2>Systems</h2>
        <span className="ov-systems-count">
          {running.length} system{running.length === 1 ? '' : 's'}
          {pinned > 0 ? ` · ${pinned} pinned` : ''}
        </span>
      </div>

      <div className="ov-toolbar">
        <label className="ov-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            placeholder="Filter systems…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter systems by name"
          />
          {q && (
            <button type="button" className="ov-search-clear" onClick={() => setQ('')} aria-label="Clear filter">
              <X size={14} />
            </button>
          )}
        </label>
        <div className="seg-toggle" role="group" aria-label="Filter systems by health">
          {SEGS.map((s) => (
            <button
              key={s.value}
              className={seg === s.value ? 'on' : ''}
              aria-pressed={seg === s.value}
              onClick={() => setSeg(s.value)}
            >
              {s.label} <span className="ov-seg-n">{s.n}</span>
            </button>
          ))}
        </div>
      </div>

      {shown.length ? (
        <div className="ov-sys-grid">
          {shown.map((s) => (
            <SystemCard key={s.key} system={s} isFav={isFav(s.key)} onToggleFav={toggle} />
          ))}
        </div>
      ) : (
        <div className="ov-empty">
          <span>No systems match{needle ? ` “${q.trim()}”` : ' this filter'}.</span>
          <button type="button" className="chip clear" onClick={() => { setQ(''); setSeg('all'); }}>
            <X size={13} /> Clear
          </button>
        </div>
      )}
    </section>
  );
}

// ── Panel bodies ─────────────────────────────────────────────────────────────
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
          <span className="ov-alert-why">
            {n.kind === 'orphan-route' && n.route?.provider === 'file'
              ? 'host process'
              : n.kind === 'orphan-route'
              ? 'no container'
              : 'down'}
          </span>
          <ArrowRight size={14} className="ov-alert-arrow" />
        </Link>
      ))}
    </div>
  );
}

function UiList({ links }: { links: UiLink[] }) {
  if (!links.length) return <p className="ov-uicol-empty">Nothing browsable here.</p>;
  return (
    <ul className="ov-uilist">
      {links.map((l) => (
        <li key={l.id} className="ov-uirow">
          <span className="dot" data-state={l.status} />
          <span className="ov-uirow-name">{l.name}</span>
          <span className="ov-uirow-host">{l.host ?? (l.port != null ? `:${l.port}` : '—')}</span>
          <a className="ov-uirow-open" href={l.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${l.name}`}>
            <ExternalLink size={14} />
          </a>
        </li>
      ))}
    </ul>
  );
}

function DiskBody({ systems, df }: { systems: System[]; df: ReturnType<typeof usePortal>['data']['df'] }) {
  const rows = useMemo(() => {
    const withData = systems.filter((s) => s.volumes.length > 0);
    const dataOnly = new Set(dataOnlySystems(systems).map((s) => s.key));
    return withData
      .map((s) => ({ system: s, bytes: systemDiskBytes(df, s), stopped: dataOnly.has(s.key) }))
      .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.system.title.localeCompare(b.system.title));
  }, [systems, df]);

  if (!rows.length) return <p className="ov-uicol-empty">No persistent volumes.</p>;

  return (
    <div className="ov-disk">
      {rows.map(({ system, bytes, stopped }) => (
        <Link
          key={system.key}
          to={`/systems/${encodeURIComponent(system.key)}`}
          className="ov-disk-row"
          style={{ ['--acc' as string]: `var(${system.accent})` } as React.CSSProperties}
        >
          <span className="ov-disk-name">{system.title}</span>
          {stopped && <span className="tag ov-disk-tag">stopped</span>}
          <span className="ov-disk-vols">{system.volumes.length} vol{system.volumes.length === 1 ? '' : 's'}</span>
          <span className="ov-disk-size">{df ? fmtBytes(bytes) : '—'}</span>
        </Link>
      ))}
    </div>
  );
}

function RecentBody({ nodes }: { nodes: PortalNode[] }) {
  const recent = useMemo(() => recentlyStarted(nodes), [nodes]);
  if (!recent.length) return <p className="ov-uicol-empty">Nothing started recently.</p>;
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

// ── Page ──────────────────────────────────────────────────────────────────────
export function Overview() {
  const { data } = usePortal();
  const systems = useMemo(() => systemsOf(data.nodes), [data.nodes]);
  const { stack, project } = useMemo(() => uiPorts(data.nodes), [data.nodes]);
  const attentionN = useMemo(() => needsAttention(data.nodes).length, [data.nodes]);
  const bothDown = data.nodes.length === 0 && data.fails > 0;

  const diskTotal = useMemo(() => {
    let sum = 0; let any = false;
    for (const s of systems) for (const v of s.volumes) {
      const b = volumeSize(data.df, v.name);
      if (b != null) { sum += b; any = true; }
    }
    return any ? sum : null;
  }, [systems, data.df]);

  const recentN = useMemo(() => recentlyStarted(data.nodes).length, [data.nodes]);

  // Never blank: if both APIs are unreachable, fall back to the static known
  // hosts so the links still work when the services do (portal.md).
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
        {/* Quick links — three readable anchors, one tidy row */}
        <QuickLinks nodes={data.nodes} />

        {/* Systems grid — the centrepiece */}
        <Reveal as="div">
          <SystemsGrid systems={systems} />
        </Reveal>

        {/* Grafana-style dashboard: fixed-height panels that scroll internally */}
        <Reveal as="div">
          <div className="ov-dash">
            <Panel
              title="Needs attention"
              Icon={AlertTriangle}
              className={attentionN ? 'is-warn' : ''}
              meta={attentionN ? `${attentionN}` : 'clear'}
            >
              <AttentionBody nodes={data.nodes} />
            </Panel>

            <Panel title="Stack UIs" Icon={Waypoints} meta={stack.length}>
              <UiList links={stack} />
            </Panel>

            <Panel title="Project UIs" Icon={ExternalLink} meta={project.length}>
              <UiList links={project} />
            </Panel>

            <Panel
              title="Data & disk"
              Icon={HardDrive}
              meta={data.df ? fmtBytes(diskTotal) : 'no sizes'}
            >
              <DiskBody systems={systems} df={data.df} />
            </Panel>

            {recentN > 0 && (
              <Panel title="Recent activity" Icon={Clock} meta={recentN}>
                <RecentBody nodes={data.nodes} />
              </Panel>
            )}
          </div>
        </Reveal>
      </div>
    </div>
  );
}
