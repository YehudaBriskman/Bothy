import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ExternalLink, AlertTriangle, ArrowRight, HardDrive,
  BookOpen, BarChart3, type LucideIcon,
} from 'lucide-react';
import { usePortal, needsAttention, healthOf, expectedUp } from '../lib/data';
import {
  systemsOf, uiPorts, diskVolumes, fmtBytes,
  type System, type UiLink,
} from '../lib/systems';
import { SystemMatrix, type MatrixGroup } from '../components/SystemMatrix';
import { SystemDialog } from '../components/SystemDialog';
import { QuickView } from '../components/QuickView';
import { Vitals } from '../components/Vitals';
import { TopContainers } from '../components/TopContainers';
import { StatusBar, BarGauge, type Seg, type GaugeRow } from '../components/viz';
import { KNOWN_HOSTS, hostUrl, type PortalNode, type Status } from '../lib/discover';
import { serviceLink, systemLink, kindLabelOf } from '../lib/links';
import { Skeleton } from '../components/states';
import { ServiceIcon, StatusIcon } from '../lib/icons';
import './Overview.css';

const STATUS_LABEL: Record<Status, string> = {
  up: 'Up', starting: 'Starting', down: 'Down', stopped: 'Stopped', unknown: 'Unknown',
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
  title, meta, Icon, className, children, footer, id,
}: {
  title: string;
  meta?: ReactNode;
  Icon?: LucideIcon;
  className?: string;
  children: ReactNode;
  /** Summary strip along the bottom - the same idea as a chart's legend row. */
  footer?: ReactNode;
  id?: string;
}) {
  return (
    <section className={`ov-panel ${className ?? ''}`} id={id}>
      <header className="ov-panel-head">
        {Icon && <Icon size={14} className="ov-panel-ico" aria-hidden="true" />}
        <h2 className="ov-panel-title">{title}</h2>
        {meta != null && <span className="ov-panel-meta">{meta}</span>}
      </header>
      <div className="ov-panel-body scroll-shade">{children}</div>
      {footer != null && <footer className="ov-panel-foot">{footer}</footer>}
    </section>
  );
}

// ── quick links ──────────────────────────────────────────────────────────────
// Borderless. Seven bordered tiles read as seven competing buttons and ate a
// full-width row for a 15px label each; a navigation strip should recede.
//
// Matched by CONTAINER NAME and anchored to a PORT.
//
// Both changed on 2026-08-12, when the *.dev.test name layer was retired. This
// list used to match services by hostname and fall back to `hostUrl('docs.dev.test')`
// - so when the routers went away, `n.host` became null for everything, the
// match failed, and the whole strip collapsed to the two hard-coded anchors.
// The port is the durable identifier: it is what you actually type.
//
// `port` is the fallback only. A discovered container's own published port wins,
// so if a service is ever moved the link follows it without editing this list.
interface QuickItem { key: string; label: string; Icon?: LucideIcon; port?: number; primary?: boolean }
const QUICK_ITEMS: QuickItem[] = [
  { key: 'docs', label: 'Docs', Icon: BookOpen, port: 8085, primary: true },
  { key: 'grafana', label: 'Grafana', Icon: BarChart3, port: 3000, primary: true },
  { key: 'prometheus', label: 'Prometheus', port: 9090 },
  { key: 'dozzle', label: 'Logs', port: 8080 },
  { key: 'portainer', label: 'Portainer', port: 9000 },
  // kafka-ui:8081 REMOVED 2026-08-12 with kafka itself (retired as idle, zero
  // topics). It was still rendering a link to a port nothing listens on - see
  // the fallback rule below, which is the reason it survived the retirement.
  { key: 'cadvisor', label: 'cAdvisor', port: 8082 },
];

function QuickLinks({ nodes }: { nodes: PortalNode[] }) {
  const links = useMemo(
    () =>
      QUICK_ITEMS.map((item) => {
        const node = nodes.find(
          (n) =>
            n.browsable && n.url &&
            (n.container?.name === item.key || n.name.toLowerCase().includes(item.key)),
        );
        // Same construction as lib/discover's containerUrl: the port on whatever
        // address the portal itself was opened at, so these work from the tailnet
        // IP, MagicDNS or localhost without knowing which one is in use.
        // The fallback exists for "discovery is DOWN", not for "the service is
        // gone" - and until now it could not tell those apart, so it invented a
        // link for anything with a hardcoded port. kafka-ui kept a confident
        // entry in this bar for hours after kafka was deleted, pointing at 8081
        // where nothing listens.
        //
        // If we have nodes at all, discovery is working, so a service missing
        // from them is genuinely absent and gets no link. Only when the node list
        // is empty - the APIs failed, and we know nothing - is guessing better
        // than showing an empty bar.
        const fallback = item.port && nodes.length === 0
          ? `http://${location.hostname}:${item.port}`
          : null;
        return { ...item, node, url: node?.url ?? fallback, status: node?.status ?? null };
      }).filter((l) => l.url),
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

// ── the status line ──────────────────────────────────────────────────────────
// One line, not a 160px card.
//
// WHAT THIS REPLACED, AND WHY. The hero used to state the same ratio four
// times - a 46px number, a part-to-whole bar, a written legend, and a "Healthy
// %" stat cell - and then surround it with four more cells. Two of those cells
// were duplicates of things on the same screen (`Systems` is countable in the
// matrix immediately below; `Data` repeated the Data & disk panel header), and
// `Trend` was a session-only ring buffer that read "collecting…" on every fresh
// load and has been obsolete since real metrics arrived. That is the footprint
// rule inverted: the loudest element on the page carried the least information,
// and it pushed the graphs that carry the most below the fold.
//
// WORSE, IT CONTRADICTED ITSELF. With 7 services `unknown`, the page showed
// "Healthy 68%" beside "Needs a look: none" and "Everything meant to be running
// is up". All three at once, six pixels apart. `unknown` means WE HAVE NOT
// CHECKED - those are the @file host routes with no container to inspect - so
// it is neither a pass nor a fault, and the old copy silently treated it as
// both. Unverified services now get their own count and their own sentence.
function StatusLine({
  up, unknown, stopped, expected, attentionN, segs, aside, degraded,
}: {
  up: number; unknown: number; stopped: number; expected: number; attentionN: number;
  segs: Seg[]; aside: Seg[]; degraded: string[];
}) {
  // The claim is scoped to what actually reported in. Saying "everything is up"
  // while a third of the box is unverified is the bug this wording fixes.
  const verified = expected - unknown;
  const allVerifiedUp = up >= verified && attentionN === 0;

  return (
    <section className={`ov-status ${attentionN ? 'is-warn' : ''}`}>
      <div className="ov-status-head">
        <span className="ov-status-counts">
          <b className="tnum">{up}</b>
          <span className="ov-status-lbl">up</span>
          {unknown > 0 && (
            <>
              <span className="ov-status-sep">·</span>
              <b className="tnum is-unknown">{unknown}</b>
              <span className="ov-status-lbl">unverified</span>
            </>
          )}
          {stopped > 0 && (
            <>
              <span className="ov-status-sep">·</span>
              <b className="tnum is-off">{stopped}</b>
              <span className="ov-status-lbl">off</span>
            </>
          )}
        </span>
        {/* `aside` keeps switched-off services OUT of the bar's whole, so the
            bar and the counts beside it describe the same population. */}
        <StatusBar segs={segs} aside={aside} height={8} />
      </div>

      <p className="ov-status-note">
        {attentionN > 0 ? (
          <>
            <StatusIcon status="down" size={13} />
            <a href="#needs-attention">
              {attentionN} service{attentionN === 1 ? '' : 's'} need{attentionN === 1 ? 's' : ''} a look
            </a>
          </>
        ) : (
          <>
            <StatusIcon status={allVerifiedUp ? 'up' : 'unknown'} size={13} />
            {allVerifiedUp
              ? `All ${verified} services that report in are up.`
              : `${up} of ${verified} confirmed up.`}
          </>
        )}
        {unknown > 0 && (
          <span className="ov-status-sub">
            {unknown} can’t be verified - host routes with no container to ask.
          </span>
        )}
      </p>

      {degraded.length > 0 && (
        <p className="ov-status-degraded">
          <AlertTriangle size={13} aria-hidden="true" />
          {degraded.join(' and ')} unreachable - these numbers cover only what is still visible.
        </p>
      )}
    </section>
  );
}

// ── exceptions ───────────────────────────────────────────────────────────────
// Not a panel any more. "Needs attention" spent a fixed grid cell whether or not
// it had anything to say, which is backwards for the one section on the page
// that should be invisible on a healthy box and impossible to miss on a sick
// one. It is now a strip directly under the hero, rendered only when non-empty;
// the clear case is one line inside the hero.
function AttentionStrip({ attention }: { attention: PortalNode[] }) {
  if (!attention.length) return null;
  return (
    <section className="ov-attn" id="needs-attention" aria-label="Needs attention">
      <h2 className="ov-attn-h">
        <AlertTriangle size={14} aria-hidden="true" />
        Needs attention
        <span className="ov-attn-n">{attention.length}</span>
      </h2>
      <div className="ov-attn-list">
        {attention.map((n) => (
          <Link to={serviceLink(n)} className="ov-alert" key={n.id}>
            <span className="ico sm"><ServiceIcon node={n} size={15} /></span>
            <span className="ov-alert-name">{n.name}</span>
            <StatusIcon status={n.status} />
            <span className="ov-alert-why">{n.status === 'down' ? 'down' : n.status === 'stopped' ? 'stopped' : kindLabelOf(n).label}</span>
            <ArrowRight size={14} className="ov-alert-arrow" />
          </Link>
        ))}
      </div>
    </section>
  );
}

// Stack and project UIs in ONE panel - two panels of the same shape competing
// for the same row was the duplication, not the content.
function UiBody({ stack, project }: { stack: UiLink[]; project: UiLink[] }) {
  // Open on a tab that HAS something. It used to always open on "Projects",
  // which was fine while the @file host routes made that list non-empty - and
  // the moment those went away (2026-08-12) the panel greeted you with
  // "Nothing browsable here" while ten stack UIs sat one click away, unseen.
  // A default that is empty is a default that is wrong.
  const [tab, setTab] = useState<'project' | 'stack'>(project.length ? 'project' : 'stack');
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
              <span className="ov-uirow-host">{l.host ?? (l.port != null ? `:${l.port}` : '-')}</span>
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

// `Service mix` and `Recent activity` are DELETED, not moved.
//
// Service mix was a histogram of how many web / db / cache services exist. It is
// a fact about the box's composition that changes maybe twice a month, given a
// permanent panel on the page you look at to answer "is anything broken right
// now". Recent activity listed containers started in the last 30 minutes, which
// on a box that stays up for days is empty almost always - a panel whose usual
// state is "No restarts since the box came up" is spending a grid cell to say
// nothing. Both remain derivable (groupByType / recentlyStarted are still
// exported and still tested); neither earns standing room on the Overview.

// ── page ─────────────────────────────────────────────────────────────────────
export function Overview() {
  const { data } = usePortal();
  const systems = useMemo(() => systemsOf(data.nodes), [data.nodes]);
  // The system whose quick-lookup dialog is open. Held by key rather than by
  // object so the dialog follows the LIVE system across a poll - holding the
  // object froze it at the instant it was clicked, and this page repolls every
  // ten seconds, so an open dialog showed stale statuses.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openSystem = useMemo(
    () => systems.find((s) => s.key === openKey) ?? null,
    [systems, openKey],
  );
  const { stack, project } = useMemo(() => uiPorts(data.nodes), [data.nodes]);
  // Computed once and shared: the hero's count, the strip's list and the
  // matrix's per-system flag all read from this one result.
  const attention = useMemo(() => needsAttention(data.nodes), [data.nodes]);
  const attentionN = attention.length;
  const attentionIds = useMemo(() => new Set(attention.map((n) => n.id)), [attention]);
  const bothDown = data.nodes.length === 0 && data.fails > 0;
  const loading = data.at === 0 && data.fails === 0;

  const { diskTotal, volumeCount } = useMemo(() => {
    const vols = diskVolumes(data.df, systems);
    let sum = 0; let any = false;
    for (const v of vols) if (v.bytes != null) { sum += v.bytes; any = true; }
    return { diskTotal: any ? sum : null, volumeCount: vols.length };
  }, [systems, data.df]);

  const counts = useMemo(() => healthOf(data.nodes), [data.nodes]);

  // Services that are meant to be up right now. Stopped ones are excluded from
  // the hero's denominator and from the healthy %: with them in, switching a
  // project off pushed the headline number down and the box read as broken when
  // it was merely idle.
  const expected = expectedUp(counts);

  // The bar's whole == the number's denominator. Stopped is shown, but detached.
  const segs: Seg[] = [
    { key: 'up', n: counts.up, label: 'up' },
    { key: 'starting', n: counts.starting, label: 'starting' },
    { key: 'down', n: counts.down, label: 'down' },
    { key: 'unknown', n: counts.unknown, label: 'unknown' },
  ];
  const aside: Seg[] = [{ key: 'stopped', n: counts.stopped, label: 'stopped' }];

  const degraded = useMemo(
    () => [...new Set(data.errors.map((e) => e.src.split(' ')[0]))],
    [data.errors],
  );

  // Grouping survives - projects, the shared stack and the plumbing really are
  // three different kinds of thing - but as headings over one flow of chips,
  // not as three cards with independent open/closed state.
  const groups = useMemo<MatrixGroup[]>(() => {
    const of = (k: System['kind']) => systems.filter((s) => s.kind === k);
    return [
      { key: 'project', title: 'Projects', systems: of('project') },
      { key: 'stack', title: 'Stack', systems: of('stack') },
      { key: 'infra', title: 'Infrastructure', systems: of('infra') },
    ].filter((g) => g.systems.length > 0);
  }, [systems]);

  const floorLinks = KNOWN_HOSTS.map(([host, name]) => ({ id: host, name, url: hostUrl(host) ?? `http://${host}` }));

  return (
    <div className="overview">
      {bothDown && (
        <div className="state err ov-offline">
          <h4>Can't reach the APIs</h4>
          <p>Showing known service names only - live status, ports and projects are unavailable. The links below still work if the services do.</p>
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
          <Skeleton variant="overview" />
        ) : (
          <>
            {/* Order is the page's hierarchy. "Is anything broken" is the
                question this page exists for, so it is first and it is the
                largest type on the screen. "How is the machine doing" is second.
                Everything below is detail behind those two. */}
            <StatusLine
              up={counts.up}
              unknown={counts.unknown}
              stopped={counts.stopped}
              expected={expected}
              attentionN={attentionN}
              segs={segs}
              aside={aside}
              degraded={degraded}
            />

            <QuickView />

            <AttentionStrip attention={attention} />

            <SystemMatrix
              groups={groups}
              attentionIds={attentionIds}
              onOpen={(s) => setOpenKey(s.key)}
            />

            {/* The graphs. Deliberately BELOW the health answer: "is anything
                broken" is the question this page exists for, and a row of charts
                above it would be three pretty things standing in front of the
                one sentence you came to read. */}
            <Vitals />

            <div className="ov-dash">
              <Panel
                title="Open a UI"
                Icon={ExternalLink}
                meta={stack.length + project.length}
                footer={
                  <>
                    <span><b>{project.length}</b> project</span>
                    <span className="sep">·</span>
                    <span><b>{stack.length}</b> stack</span>
                    <span className="right">opens in a new tab</span>
                  </>
                }
              >
                <UiBody stack={stack} project={project} />
              </Panel>

              <Panel
                title="Data & disk"
                Icon={HardDrive}
                meta={data.df ? fmtBytes(diskTotal) : 'no sizes'}
                footer={
                  <>
                    <span><b>{volumeCount}</b> volumes</span>
                    <span className="sep">·</span>
                    <span>total <b>{diskTotal != null ? fmtBytes(diskTotal) : '-'}</b></span>
                    {!data.df && <span className="right">sizes unavailable</span>}
                  </>
                }
              >
                <DiskBody systems={systems} df={data.df} />
              </Panel>

              <TopContainers />
            </div>
          </>
        )}
      </div>

      <SystemDialog
        system={openSystem}
        open={openSystem != null}
        onOpenChange={(o) => !o && setOpenKey(null)}
      />
    </div>
  );
}
