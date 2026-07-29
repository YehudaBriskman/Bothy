import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePortal } from '../lib/data';
import { panelize } from '../lib/panels';
import { STATUS_HEX } from '../components/three/webgl';
import { serviceLink } from '../lib/links';
import type { PortalNode } from '../lib/discover';
import './Topology.css';

// The heavy three.js scene stays in its own lazy chunk (never in the main
// bundle). Topology itself is imported eagerly by App, so the split lives here.
const TopologyScene = lazy(() =>
  import('../components/three/StackScene').then((m) => ({ default: m.TopologyScene })),
);

type View = '3d' | 'flat';

export function Topology() {
  const [view, setView] = useState<View>('3d');

  return (
    <div className="page topology-page">
      <div className="page-head">
        <div>
          <h1>Topology</h1>
          <p className="page-sub">edge → rack → container floor · nodes lit by live status · click to inspect</p>
        </div>
        <div className="topo-head-right">
          <div className="topo-view" role="group" aria-label="Topology view">
            <button
              type="button"
              className={`topo-view-btn${view === '3d' ? ' is-on' : ''}`}
              aria-pressed={view === '3d'}
              onClick={() => setView('3d')}
            >
              3D
            </button>
            <button
              type="button"
              className={`topo-view-btn${view === 'flat' ? ' is-on' : ''}`}
              aria-pressed={view === 'flat'}
              onClick={() => setView('flat')}
            >
              Flat map
            </button>
          </div>
          <div className="topo-legend">
            {(['up', 'starting', 'down', 'unknown'] as const).map((s) => (
              <span key={s} className="leg"><span className="leg-dot" style={{ background: STATUS_HEX[s] }} /> {s}</span>
            ))}
          </div>
        </div>
      </div>

      {view === '3d' ? (
        <div className="topo-3d">
          <Suspense fallback={<div className="topo-3d-loading">Loading 3D topology…</div>}>
            <TopologyScene />
          </Suspense>
        </div>
      ) : (
        <FlatMap />
      )}
    </div>
  );
}

// ── the classic edge → service → container SVG graph (the "Flat map" view) ────

const HUB_X = 90;
const SVC_X = 470;
const CTR_X = 850;
const ROW = 42;
const GROUP_GAP = 22;
const TOP = 60;

interface Placed {
  node: PortalNode;
  y: number;
  group: string;
}

function FlatMap() {
  const { data } = usePortal();
  const nav = useNavigate();
  const [hover, setHover] = useState<string | null>(null);

  const { placed, height, groups } = useMemo(() => {
    const panels = panelize(data.nodes);
    const placed: Placed[] = [];
    const groups: { title: string; y0: number; y1: number }[] = [];
    let y = TOP;
    for (const p of panels) {
      const y0 = y - 18;
      for (const n of p.nodes) {
        placed.push({ node: n, y, group: p.title });
        y += ROW;
      }
      groups.push({ title: p.title, y0, y1: y - ROW + 14 });
      y += GROUP_GAP;
    }
    return { placed, height: Math.max(360, y), groups };
  }, [data.nodes]);

  const hubY = height / 2;
  const isLit = (id: string) => hover === null || hover === id || hover === 'hub';
  const go = (n: PortalNode) => nav(serviceLink(n));

  return (
    <div className="topo-wrap">
      <svg viewBox={`0 0 960 ${height}`} className="topo-svg" preserveAspectRatio="xMidYMin meet" role="img" aria-label="Service topology graph">
        {/* column captions */}
        <text x={HUB_X} y={30} className="topo-col">edge</text>
        <text x={SVC_X} y={30} className="topo-col">services</text>
        <text x={CTR_X} y={30} className="topo-col">containers</text>

        {/* group bands */}
        {groups.map((g) => (
          <g key={g.title}>
            <rect x={SVC_X - 150} y={g.y0} width={300} height={g.y1 - g.y0} rx={10} className="topo-band" />
            <text x={SVC_X - 150} y={g.y0 - 4} className="topo-band-label">{g.title}</text>
          </g>
        ))}

        {/* edges: hub -> service (routed), service -> container */}
        {placed.map(({ node, y }) => {
          const lit = isLit(node.id);
          const hex = STATUS_HEX[node.status];
          const hasRoute = !!node.route;
          const hasCtr = !!node.container;
          const active = hover === node.id;
          return (
            <g key={`e-${node.id}`}>
              {hasRoute && (
                <path
                  d={`M ${HUB_X + 14} ${hubY} C ${(HUB_X + SVC_X) / 2} ${hubY}, ${(HUB_X + SVC_X) / 2} ${y}, ${SVC_X - 90} ${y}`}
                  className={`topo-edge ${active ? 'on' : ''}`}
                  style={{ stroke: hex, opacity: active ? 0.9 : lit ? 0.5 : 0.07 }}
                  fill="none"
                />
              )}
              {hasCtr && (
                <path
                  d={`M ${SVC_X + 90} ${y} C ${(SVC_X + CTR_X) / 2} ${y}, ${(SVC_X + CTR_X) / 2} ${y}, ${CTR_X - 12} ${y}`}
                  className={`topo-edge ${active ? 'on' : ''}`}
                  style={{ stroke: hex, opacity: active ? 0.9 : lit ? 0.45 : 0.07 }}
                  fill="none"
                />
              )}
            </g>
          );
        })}

        {/* hub */}
        <g
          className="topo-hub"
          onMouseEnter={() => setHover('hub')}
          onMouseLeave={() => setHover(null)}
        >
          <circle cx={HUB_X} cy={hubY} r={26} className="topo-hub-c" />
          <text x={HUB_X} y={hubY + 4} className="topo-hub-t">edge</text>
          <text x={HUB_X} y={hubY + 44} className="topo-hub-sub">Traefik</text>
        </g>

        {/* service nodes */}
        {placed.map(({ node, y }) => {
          const hex = STATUS_HEX[node.status];
          const lit = isLit(node.id);
          const active = hover === node.id;
          return (
            <g
              key={node.id}
              className={`topo-node ${active ? 'on' : ''}`}
              transform={`translate(${SVC_X} ${y})`}
              style={{ opacity: lit ? 1 : 0.22 }}
              tabIndex={0}
              role="link"
              aria-label={`${node.name} — ${node.status}. Open details.`}
              onMouseEnter={() => setHover(node.id)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(node.id)}
              onBlur={() => setHover(null)}
              onClick={() => go(node)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(node); } }}
            >
              <title>{node.name} · {node.status}{node.host ? ` · ${node.host}` : ''}</title>
              <circle r={13} className="topo-node-halo" style={{ fill: hex }} />
              <circle r={7} className="topo-node-dot" style={{ fill: hex, filter: `drop-shadow(0 0 5px ${hex})` }} />
              <text x={18} y={4} className="topo-label">{node.name}</text>
            </g>
          );
        })}

        {/* container nodes */}
        {placed.filter((p) => p.node.container).map(({ node, y }) => {
          const hex = STATUS_HEX[node.status];
          const active = hover === node.id;
          return (
            <g key={`c-${node.id}`} className={`topo-ctr ${active ? 'on' : ''}`} transform={`translate(${CTR_X} ${y})`} style={{ opacity: isLit(node.id) ? 1 : 0.18 }}>
              <rect x={-7} y={-7} width={14} height={14} rx={3} style={{ fill: hex, filter: `drop-shadow(0 0 4px ${hex})` }} />
              <text x={16} y={4} className="topo-label ctr">{node.container?.image?.split(/[/:]/).slice(-2, -1)[0] || node.container?.name}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
