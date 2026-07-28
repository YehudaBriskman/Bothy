import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, ExternalLink, Activity, Boxes, Layers, Plug } from 'lucide-react';
import { usePortal, healthOf, needsAttention } from '../lib/data';
import { panelize } from '../lib/panels';
import { accentVar } from '../lib/accents';
import { KNOWN_HOSTS } from '../lib/discover';
import { serviceLink, projectLink } from '../lib/links';
import { Reveal } from '../components/Reveal';
import { ServiceIcon, StatusIcon } from '../lib/icons';
import type { PortalNode } from '../lib/discover';
import './Overview.css';

// three/r3f/drei are heavy — split them into their own chunk so the shell and the
// functional pages load fast. The Overview shows a light placeholder while the
// scene chunk streams in. Per the 3D contract the scene component sizes itself to
// its parent (~70vh, contained) and reads nodes from context, so we just place it
// inside a framed viewport. It exports `StackViewport`; older builds export
// `StackScene` (which takes `nodes`) — we accept either and always pass `nodes`,
// which the self-contained viewport simply ignores. The lead only ever needs to
// adjust this one import if the module path changes.
const StackViewport = lazy(() =>
  import('../components/three/StackScene').then((m) => {
    const mod = m as unknown as { StackViewport?: typeof m.StackScene; StackScene: typeof m.StackScene };
    return { default: mod.StackViewport ?? mod.StackScene };
  }),
);

// ── count-up: animate a number 0 → value once on mount (reduced-motion jumps) ──
function useCountUp(value: number, ms = 800): number {
  const [n, setN] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? value
      : 0,
  );
  const from = useRef(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setN(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setN(Math.round(a + (value - a) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return n;
}

function CountUp({ value }: { value: number }) {
  return <>{useCountUp(value)}</>;
}

function StatTile({
  value, label, tone, Icon,
}: {
  value: number; label: string; tone?: string; Icon: React.ComponentType<{ size?: number }>;
}) {
  return (
    <div className="ov-stat" style={tone ? ({ ['--tone' as string]: `var(${tone})` } as React.CSSProperties) : undefined}>
      <div className="ov-stat-top">
        <Icon size={15} />
        <span className="ov-stat-l">{label}</span>
      </div>
      <div className="ov-stat-n"><CountUp value={value} /></div>
    </div>
  );
}

function HealthStrip({ nodes, ports }: { nodes: PortalNode[]; ports: number }) {
  const h = healthOf(nodes);
  const projects = new Set(nodes.filter((n) => n.groupKind === 'project').map((n) => n.group)).size;
  const stacks = new Set(nodes.filter((n) => n.groupKind === 'stack').map((n) => n.group)).size;
  const pct = h.total ? Math.round((h.up / h.total) * 100) : 0;
  const allWell = h.down === 0 && h.starting === 0 && h.total > 0;
  const upN = useCountUp(h.up);

  return (
    <div className="ov-strip">
      <div className={`ov-health ${allWell ? 'well' : h.down ? 'bad' : ''}`}>
        <div className="ov-health-top">
          <StatusIcon status={h.down ? 'down' : h.starting ? 'starting' : 'up'} size={16} />
          <span className="ov-health-label">System health</span>
          <span className="ov-health-pct">{pct}%</span>
        </div>
        <div className="ov-health-n">
          <span className="up">{upN}</span>
          <span className="tot">/ {h.total || '–'}</span>
          <span className="ov-health-word">services up</span>
        </div>
        <div className="ov-bar" role="img" aria-label={`${h.up} up, ${h.starting} starting, ${h.down} down of ${h.total}`}>
          {h.up > 0 && <span className="seg up" style={{ flex: h.up }} />}
          {h.starting > 0 && <span className="seg starting" style={{ flex: h.starting }} />}
          {h.down > 0 && <span className="seg down" style={{ flex: h.down }} />}
          {h.unknown > 0 && <span className="seg unknown" style={{ flex: h.unknown }} />}
        </div>
      </div>
      <div className="ov-stats">
        <StatTile value={h.down} label="Down" tone="--down" Icon={AlertTriangle} />
        <StatTile value={h.starting} label="Starting" tone="--warn" Icon={Activity} />
        <StatTile value={projects} label="Projects" tone="--primary" Icon={Boxes} />
        <StatTile value={stacks} label="Stack svcs" tone="--primary" Icon={Layers} />
        <StatTile value={ports} label="Open ports" tone="--primary" Icon={Plug} />
      </div>
    </div>
  );
}

function ProjectHealth({ nodes }: { nodes: PortalNode[] }) {
  const panels = panelize(nodes);
  if (!panels.length) return null;
  return (
    <div className="ov-projects">
      {panels.map((p) => {
        const h = healthOf(p.nodes);
        const pct = h.total ? Math.round((h.up / h.total) * 100) : 0;
        return (
          <Link
            to={p.key.startsWith('project:') ? projectLink(p.key.slice('project:'.length)) : '/services'}
            className="ov-proj"
            key={p.key}
            style={{ ['--acc' as string]: `var(${accentVar(p.key)})` } as React.CSSProperties}
          >
            <div className="ov-proj-head">
              <span className="ov-proj-name">{p.title}</span>
              <span className="ov-proj-count">{h.up}/{h.total}</span>
            </div>
            <div className="ov-bar" role="img" aria-label={`${pct}% up`}>
              {h.up > 0 && <span className="seg up" style={{ flex: h.up }} />}
              {h.starting > 0 && <span className="seg starting" style={{ flex: h.starting }} />}
              {h.down > 0 && <span className="seg down" style={{ flex: h.down }} />}
              {h.unknown > 0 && <span className="seg unknown" style={{ flex: h.unknown }} />}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

export function Overview() {
  const { data } = usePortal();
  const attention = useMemo(() => needsAttention(data.nodes), [data.nodes]);
  const bothDown = data.nodes.length === 0 && data.fails > 0;
  const quick = useMemo(
    () => data.nodes.filter((n) => n.browsable && n.url).slice(0, 10),
    [data.nodes],
  );
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
        {/* SUMMARY FIRST — the health strip is the answer to "is the box OK?" */}
        <Reveal className="ov-section" as="div">
          <div className="ov-head">
            <Activity size={18} />
            <h2>Health</h2>
            <span className="ov-head-sub">live from Traefik + Docker</span>
          </div>
          <HealthStrip nodes={data.nodes} ports={data.ports.length} />
        </Reveal>

        {/* Needs attention — anything down or orphaned, before anything else */}
        <Reveal className="ov-section" as="div" delay={0.04}>
          <div className="ov-head">
            <AlertTriangle size={18} className={attention.length ? 'warn-ico' : ''} />
            <h2>Needs attention</h2>
            <span className="ov-head-sub">{attention.length ? `${attention.length} to look at` : 'all clear'}</span>
          </div>
          {attention.length ? (
            <div className="ov-attention">
              {attention.map((n) => (
                <Link to={serviceLink(n)} className="ov-alert" key={n.id}>
                  <span className="ico sm"><ServiceIcon node={n} size={16} /></span>
                  <span className="ov-alert-name">{n.name}</span>
                  <StatusIcon status={n.status} showLabel />
                  <span className="ov-alert-why">
                    {n.kind === 'orphan-route' && n.route?.provider === 'file' ? 'host process — may be down'
                      : n.kind === 'orphan-route' ? 'route with no container'
                      : 'service down'}
                  </span>
                  <ArrowRight size={15} className="ov-alert-arrow" />
                </Link>
              ))}
            </div>
          ) : (
            <div className="ov-clear">
              <StatusIcon status="up" size={18} /> Everything discovered is up. Nothing orphaned.
            </div>
          )}
        </Reveal>

        {/* Per-project rollup — drill-in shortcuts */}
        <Reveal className="ov-section" as="div" delay={0.04}>
          <div className="ov-head">
            <h2>Per-project health</h2>
            <span className="ov-head-sub">click a project to drill in</span>
          </div>
          <ProjectHealth nodes={data.nodes} />
        </Reveal>

        {/* The running infrastructure — the visual hero, contained (not a scroll track) */}
        <Reveal className="ov-section" as="div">
          <div className="ov-head">
            <h2>The stack</h2>
            <span className="ov-head-sub">edge · racks per project · container floor — drag · shift/ctrl-scroll to pan</span>
          </div>
          <div className="ov-viewport">
            <Suspense fallback={<div className="ov-viewport-loading" aria-hidden="true" />}>
              <StackViewport nodes={data.nodes} />
            </Suspense>
          </div>
        </Reveal>

        {/* Quick links last — the web UIs you open most */}
        <Reveal className="ov-section" as="div" delay={0.04}>
          <div className="ov-head">
            <h2>Quick links</h2>
            <span className="ov-head-sub">the web UIs you open most</span>
          </div>
          <div className="ov-quick">
            {quick.map((n) => (
              <a key={n.id} className="ov-quick-item" href={n.url!} target="_blank" rel="noopener noreferrer">
                <span className="ico sm"><ServiceIcon node={n} size={16} /></span>
                <span className="ov-quick-name">{n.name}</span>
                <ExternalLink size={14} className="ov-quick-ext" />
              </a>
            ))}
          </div>
          <Link to="/services" className="ov-all">Browse all services <ArrowRight size={15} /></Link>
        </Reveal>
      </div>
    </div>
  );
}
