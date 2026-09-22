import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePortal } from '../lib/data';
import { panelize } from '../lib/panels';
// The flat map paints in TOKENS, not in the 3D scene's hex mirror.
//
// It used to import STATUS_HEX from webgl.ts and inline it into `style`, which
// made this the one view in the app that could not re-theme: every edge, halo,
// dot, legend swatch and container square stayed on the dark palette on a white
// page. The hexes belong to the 3D scene, which paints with real materials and
// genuinely cannot read CSS; an SVG in the document can, so it should.
//
// STATUS_VAR is the `-fg` half of each pair - see the note on it - and that is
// the right half here for the same reason it is right for StatusIcon: these are
// 7px dots and 14px squares, not the large filled areas the bare fills were
// measured for.
import { STATUS_VAR } from '../lib/icons';
import { serviceLink } from '../lib/links';
import { conditionLabel, resolveEdges, type PortalNode } from '../lib/discover';
import './Topology.css';
import { Loader } from '../components/ui/Loader';

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
          <p className="page-sub">
            {view === '3d'
              ? 'edge → rack → container floor · nodes lit by live status · click to inspect'
              : (
                <>
                  declared dependencies from compose ·{' '}
                  {/* CT-10: "hover" is an instruction a finger cannot follow. Both
                      sentences are rendered and `(hover: none)` picks - the same
                      trick the flat map itself uses below, because a media query
                      can change what is shown and a component cannot ask what
                      kind of pointer is coming next. */}
                  <span className="topo-hint-fine">hover a service to isolate what it needs and what needs it</span>
                  <span className="topo-hint-coarse">tap a service to open it; each row lists what it waits for</span>
                </>
              )}
          </p>
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
              <span key={s} className="leg"><span className="leg-dot" style={{ background: `var(${STATUS_VAR[s]})` }} /> {s}</span>
            ))}
            {/* Only meaningful on the flat map - the 3D scene has no dependency
                lines to explain, and a legend for something not on screen is
                worse than no legend. */}
            {view === 'flat' && (
              <span className="leg"><span className="leg-dash" aria-hidden="true" /> waits for</span>
            )}
          </div>
        </div>
      </div>

      {view === '3d' ? (
        <div className="topo-3d">
          <Suspense fallback={<div className="topo-3d-loading"><Loader state="load" size="lg" label="Loading the 3D topology…" /></div>}>
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

  // The declared dependency edges, placed against the rows above.
  //
  // Every other line on this map is a LAYOUT artifact: hub → service is the
  // routing (real, but only 7 routers survive), and service → container is a
  // horizontal stub from a row to itself, which carries no information at all.
  // These are the only lines here that describe a relationship between two
  // different things, and they come from com.docker.compose.depends_on rather
  // than from anything this page inferred.
  const deps = useMemo(() => {
    const yOf = new Map(placed.map((p) => [p.node.id, p.y] as const));
    return resolveEdges(placed.map((p) => p.node))
      .filter((e) => e.to && yOf.has(e.from.id) && yOf.has(e.to.id))
      .map((e) => ({
        id: `${e.from.id}->${e.to!.id}:${e.condition}`,
        fromId: e.from.id,
        toId: e.to!.id,
        y1: yOf.get(e.from.id)!,
        y2: yOf.get(e.to!.id)!,
        label: conditionLabel(e.condition),
        from: e.from,
        to: e.to!,
      }));
  }, [placed]);

  // CT-10: pinned. At the centre of a 40-service map the hub sat ~800px down -
  // below the fold, on the one column the map opens on.
  const hubY = Math.min(height / 2, 240);
  const isLit = (id: string) => hover === null || hover === id || hover === 'hub';
  // A dependency is lit when EITHER end is hovered - the question is
  // symmetrical. "What does this need" and "what breaks if I stop this" are the
  // same edge read in opposite directions, and the second one is the question
  // you actually have before running `docker stop`.
  const depLit = (d: { fromId: string; toId: string }) =>
    hover === null || hover === d.fromId || hover === d.toId;
  const go = (n: PortalNode) => nav(serviceLink(n));

  return (
    <div className="topo-wrap">
      {/* CT-10: the same graph as a LIST, for a phone. The SVG has a 720px
          minimum - it has three columns and needs them - so at 390 it opened on
          the empty EDGE column and everything worth reading was off to the
          right. Both are rendered and the breakpoint picks one, which is the
          arrangement pages/control/cluster.css already uses for the cluster
          topology, and it keeps one source of truth for the edges. */}
      <FlatList placed={placed} deps={deps} onOpen={go} />
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
          const hex = `var(${STATUS_VAR[node.status]})`;
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

        {/* Declared dependencies, bulging left into the gutter between the band
            edge and the service dots - the one strip of this map that was empty.
            Drawn AFTER the routing curves so they sit on top, and dashed so the
            two kinds of line are never confused: solid = a request path, dashed
            = a startup requirement. They are different claims about the system
            and must not read as the same thing.

            Arrow points at the DEPENDENCY (the thing waited for), matching how
            the dialog words it: "grafana waits for loki". */}
        {deps.map((d) => {
          const lit = depLit(d);
          const active = hover === d.fromId || hover === d.toId;
          // Bulge scales with the row distance so neighbouring pairs stay
          // distinguishable instead of collapsing into one thick smear.
          const span = Math.abs(d.y2 - d.y1);
          const bulge = Math.min(118, 34 + span * 0.28);
          const x0 = SVC_X - 16;
          return (
            <path
              key={`d-${d.id}`}
              d={`M ${x0} ${d.y1} C ${x0 - bulge} ${d.y1}, ${x0 - bulge} ${d.y2}, ${x0} ${d.y2}`}
              className={`topo-dep${active ? ' on' : ''}`}
              style={{ opacity: active ? 0.95 : lit ? 0.42 : 0.05 }}
              markerEnd="url(#dep-arrow)"
              fill="none"
            >
              <title>{d.from.name} waits for {d.to.name} {d.label}</title>
            </path>
          );
        })}

        <defs>
          <marker id="dep-arrow" viewBox="0 0 8 8" refX="7" refY="4"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 7 4 L 0 7 z" className="topo-dep-head" />
          </marker>
        </defs>

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
          const hex = `var(${STATUS_VAR[node.status]})`;
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
              aria-label={`${node.name} - ${node.status}. Open details.`}
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
          const hex = `var(${STATUS_VAR[node.status]})`;
          const active = hover === node.id;
          return (
            <g key={`c-${node.id}`} className={`topo-ctr ${active ? 'on' : ''}`} transform={`translate(${CTR_X} ${y})`} style={{ opacity: isLit(node.id) ? 1 : 0.18 }}>
              <rect x={-7} y={-7} width={14} height={14} rx={3} style={{ fill: hex, filter: `drop-shadow(0 0 4px ${hex})` }} />
              <text x={16} y={4} className="topo-label ctr">{node.container?.image?.replace(/@.*$/, '').split(/[/:]/).slice(-2, -1)[0] || node.container?.name}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** CT-10: the flat map at phone width.
 *
 *  The same three facts the SVG draws - what a service is, what it waits for
 *  and what waits on it - as rows a 390px screen can actually read. It is not a
 *  cut-down map: the dependency edges are the only lines on that map that
 *  describe a relationship between two different things (hub-to-service is
 *  routing and service-to-container is a stub from a row to itself), and they
 *  are all here.
 */
function FlatList({
  placed, deps, onOpen,
}: {
  placed: Placed[];
  deps: { fromId: string; toId: string; label: string; from: PortalNode; to: PortalNode }[];
  onOpen: (n: PortalNode) => void;
}) {
  const byGroup = useMemo(() => {
    const out: { title: string; rows: Placed[] }[] = [];
    for (const pl of placed) {
      const last = out[out.length - 1];
      if (last && last.title === pl.group) last.rows.push(pl);
      else out.push({ title: pl.group, rows: [pl] });
    }
    return out;
  }, [placed]);

  return (
    <div className="topo-list">
      {byGroup.map((g) => (
        <section key={g.title} className="topo-list-group">
          <h2 className="topo-list-gh eyebrow">{g.title}</h2>
          <ul className="topo-list-rows">
            {g.rows.map(({ node }) => {
              const waits = deps.filter((d) => d.fromId === node.id);
              const needed = deps.filter((d) => d.toId === node.id);
              return (
                <li key={node.id} className="topo-list-row">
                  <button type="button" className="topo-list-open" onClick={() => onOpen(node)}>
                    <span className="topo-list-dot" style={{ background: `var(${STATUS_VAR[node.status]})` }} aria-hidden="true" />
                    <span className="topo-list-name">{node.name}</span>
                    <span className="topo-list-status">{node.status}</span>
                  </button>
                  {(waits.length > 0 || needed.length > 0) && (
                    <p className="topo-list-deps">
                      {waits.map((d) => (
                        <span key={`w-${d.toId}`} className="topo-chip" title={`${node.name} ${d.label} ${d.to.name}`}>
                          <span className="topo-chip-k">waits for</span> {d.to.name}
                        </span>
                      ))}
                      {needed.map((d) => (
                        <span key={`n-${d.fromId}`} className="topo-chip is-in" title={`${d.from.name} ${d.label} ${node.name}`}>
                          <span className="topo-chip-k">needed by</span> {d.from.name}
                        </span>
                      ))}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {placed.length === 0 && <p className="sa-note">Nothing is running to map.</p>}
    </div>
  );
}
