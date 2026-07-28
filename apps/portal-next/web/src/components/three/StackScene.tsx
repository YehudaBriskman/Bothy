import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeElements } from '@react-three/fiber';
import { Html, Instance, Instances, OrbitControls, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { useNavigate } from 'react-router-dom';
import { usePortal } from '../../lib/data';
import { panelize, type Panel } from '../../lib/panels';
import type { PortalNode, Status } from '../../lib/discover';
import { serviceLink } from '../../lib/links';
import { ServiceIcon, StatusIcon } from '../../lib/icons';
import { hasWebGL, prefersReducedMotion, statusHexes, cssVar, STATUS_HEX, STATUS_LABEL } from './webgl';
import { StaticStack } from './StaticStack';
import './three.css';

// ── layout constants (world units; 1U slab ≈ 0.5 tall) ───────────────────────
const SLAB_W = 2.2;
const SLAB_H = 0.5;
const SLAB_D = 1.3;
const SLAB_PITCH = 0.6; // slab height + gap
const RW = SLAB_W + 0.5; // rack outer width
const RD = SLAB_D + 0.4; // rack outer depth
const RACK_PITCH = RW + 1.0; // centre-to-centre spacing of racks
const MAX_UNITS = 14; // cap detail per rack
const FLOOR_Y = -0.7;
const FLOOR_Z = RD / 2 + 2.2;

type Hexes = Record<Status, string>;
type Focus = 'edge' | 'projects' | 'containers';
type Hover = { id: string; node: PortalNode } | null;

const rackPostH = (count: number) => Math.max(1, count) * SLAB_PITCH + 0.7;
const emissiveFor = (s: Status) => (s === 'up' ? 0.7 : s === 'unknown' ? 0.22 : 1.1);

// ── shared soft-glow sprite texture (one canvas, reused, tinted per LED) ──────
let _glow: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (_glow) return _glow;
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _glow = new THREE.CanvasTexture(cv);
  return _glow;
}

type GroupProps = ThreeElements['group'];

// ── one 1U server slab: metal chassis, front bezel, vents, ports, status LED ──
function Slab({
  node, colorHex, hovered, onHover, onOut, onSelect, ...props
}: {
  node: PortalNode;
  colorHex: string;
  hovered: boolean;
  onHover: () => void;
  onOut: () => void;
  onSelect: () => void;
} & GroupProps) {
  const grp = useRef<THREE.Group>(null);
  useFrame(() => {
    // hovered slab eases forward like a pulled drawer
    if (grp.current) {
      grp.current.position.z = THREE.MathUtils.lerp(grp.current.position.z, hovered ? 0.18 : 0, 0.2);
    }
  });
  const emis = emissiveFor(node.status);

  return (
    <group
      {...props}
      onPointerOver={(e) => { e.stopPropagation(); onHover(); }}
      onPointerOut={(e) => { e.stopPropagation(); onOut(); }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
    >
      <group ref={grp}>
        {/* chassis */}
        <RoundedBox args={[SLAB_W, SLAB_H, SLAB_D]} radius={0.03} smoothness={2}>
          <meshStandardMaterial color={hovered ? '#232d40' : '#182031'} metalness={0.85} roughness={0.36} />
        </RoundedBox>
        {/* brushed front bezel, slightly proud */}
        <mesh position={[0, 0, SLAB_D / 2 + 0.001]}>
          <planeGeometry args={[SLAB_W - 0.05, SLAB_H - 0.06]} />
          <meshStandardMaterial color="#10151f" metalness={0.55} roughness={0.5} />
        </mesh>
        {/* vent slits, left third */}
        {[0, 1, 2, 3].map((i) => (
          <mesh key={i} position={[-SLAB_W / 2 + 0.36, SLAB_H / 2 - 0.11 - i * 0.085, SLAB_D / 2 + 0.012]}>
            <boxGeometry args={[0.62, 0.028, 0.012]} />
            <meshStandardMaterial color="#05070c" roughness={0.95} />
          </mesh>
        ))}
        {/* drive handle */}
        <mesh position={[SLAB_W / 2 - 0.62, 0, SLAB_D / 2 + 0.02]}>
          <boxGeometry args={[0.5, 0.13, 0.03]} />
          <meshStandardMaterial color="#39465e" metalness={0.7} roughness={0.42} />
        </mesh>
        {/* two port dots */}
        {[0, 1].map((i) => (
          <mesh key={i} position={[SLAB_W / 2 - 0.14 - i * 0.16, -SLAB_H / 2 + 0.12, SLAB_D / 2 + 0.02]}>
            <boxGeometry args={[0.07, 0.07, 0.02]} />
            <meshStandardMaterial color="#22d3ee" emissive="#22d3ee" emissiveIntensity={0.5} toneMapped={false} />
          </mesh>
        ))}
        {/* status LED + additive glow */}
        <mesh position={[SLAB_W / 2 - 0.14, SLAB_H / 2 - 0.12, SLAB_D / 2 + 0.02]}>
          <boxGeometry args={[0.09, 0.09, 0.03]} />
          <meshStandardMaterial color={colorHex} emissive={colorHex} emissiveIntensity={emis} toneMapped={false} />
        </mesh>
        <sprite position={[SLAB_W / 2 - 0.14, SLAB_H / 2 - 0.12, SLAB_D / 2 + 0.08]} scale={hovered ? 0.52 : 0.34}>
          <spriteMaterial map={glowTexture()} color={colorHex} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0.9} />
        </sprite>

        {hovered && <Tooltip node={node} />}
      </group>
    </group>
  );
}

// drei <Html> tooltip anchored to the slab (tracks orbit); crisp, screen-sized.
function Tooltip({ node }: { node: PortalNode }) {
  return (
    <Html position={[0, SLAB_H / 2 + 0.08, SLAB_D / 2 + 0.05]} center zIndexRange={[120, 0]} className="sv-tip" occlude={false}>
      <div className="sv-tip-card">
        <div className="sv-tip-head">
          <ServiceIcon node={node} size={15} className="sv-tip-ico" />
          <span className="sv-tip-name">{node.name}</span>
        </div>
        <div className="sv-tip-row">
          <StatusIcon status={node.status} size={13} showLabel />
        </div>
        {node.host && <div className="sv-tip-sub mono">{node.host}</div>}
        {node.container?.image && <div className="sv-tip-sub sv-tip-img mono">{node.container.image}</div>}
      </div>
    </Html>
  );
}

// ── a rack cabinet: dark metal frame + rails + a column of stacked slabs ──────
function Rack({
  panel, x, hexes, hover, setHover, onSelect,
}: {
  panel: Panel;
  x: number;
  hexes: Hexes;
  hover: Hover;
  setHover: (h: Hover) => void;
  onSelect: (n: PortalNode) => void;
}) {
  const units = panel.nodes.slice(0, MAX_UNITS);
  const postH = rackPostH(units.length);
  const frameMat = <meshStandardMaterial color="#0d1119" metalness={0.9} roughness={0.3} />;
  const posts: [number, number][] = [
    [RW / 2, RD / 2], [-RW / 2, RD / 2], [RW / 2, -RD / 2], [-RW / 2, -RD / 2],
  ];

  return (
    <group position={[x, 0, 0]}>
      {/* base + top cap */}
      <mesh position={[0, 0.06, 0]}>
        <boxGeometry args={[RW + 0.1, 0.12, RD + 0.1]} />
        {frameMat}
      </mesh>
      <mesh position={[0, postH, 0]}>
        <boxGeometry args={[RW + 0.1, 0.12, RD + 0.1]} />
        {frameMat}
      </mesh>
      {/* corner posts */}
      {posts.map(([px, pz], i) => (
        <mesh key={i} position={[px, postH / 2, pz]}>
          <boxGeometry args={[0.1, postH, 0.1]} />
          {frameMat}
        </mesh>
      ))}
      {/* back panel */}
      <mesh position={[0, postH / 2, -RD / 2]}>
        <planeGeometry args={[RW, postH]} />
        <meshStandardMaterial color="#0a0d14" metalness={0.6} roughness={0.6} side={THREE.DoubleSide} />
      </mesh>
      {/* front mounting rails */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (SLAB_W / 2 + 0.06), postH / 2, RD / 2 - 0.02]}>
          <boxGeometry args={[0.05, postH - 0.2, 0.05]} />
          <meshStandardMaterial color="#2b3446" metalness={0.8} roughness={0.4} />
        </mesh>
      ))}

      {/* stacked 1U slabs */}
      {units.map((n, i) => (
        <Slab
          key={n.id}
          node={n}
          colorHex={hexes[n.status]}
          hovered={hover?.id === n.id}
          position={[0, 0.5 + i * SLAB_PITCH, 0]}
          onHover={() => setHover({ id: n.id, node: n })}
          onOut={() => setHover(null)}
          onSelect={() => onSelect(n)}
        />
      ))}

      {/* project nameplate */}
      <Html position={[0, postH + 0.5, 0]} center distanceFactor={11} className="sv-plate" occlude={false}>
        <span className="sv-plate-txt">{panel.title}</span>
      </Html>
    </group>
  );
}

// ── the edge/Traefik unit — a wide accent bar sitting above the racks ─────────
function EdgeBar({
  panel, width, y, hexes, hover, setHover, onSelect, primary,
}: {
  panel: Panel;
  width: number;
  y: number;
  hexes: Hexes;
  hover: Hover;
  setHover: (h: Hover) => void;
  onSelect: (n: PortalNode) => void;
  primary: string;
}) {
  const nodes = panel.nodes.slice(0, 8);
  const span = width - 1.4;
  const step = nodes.length > 1 ? span / (nodes.length - 1) : 0;
  const start = -span / 2;
  return (
    <group position={[0, y, 0]}>
      <RoundedBox args={[width, 0.72, RD + 0.2]} radius={0.05} smoothness={2}>
        <meshStandardMaterial color="#141b2c" metalness={0.85} roughness={0.32} emissive={primary} emissiveIntensity={0.12} />
      </RoundedBox>
      {/* accent stripe */}
      <mesh position={[0, 0.2, (RD + 0.2) / 2 + 0.01]}>
        <planeGeometry args={[width - 0.3, 0.05]} />
        <meshStandardMaterial color={primary} emissive={primary} emissiveIntensity={1.3} toneMapped={false} />
      </mesh>
      {/* one clickable module per edge node */}
      {nodes.map((n, i) => (
        <group
          key={n.id}
          position={[start + i * step, -0.05, (RD + 0.2) / 2 + 0.02]}
          onPointerOver={(e) => { e.stopPropagation(); setHover({ id: n.id, node: n }); }}
          onPointerOut={(e) => { e.stopPropagation(); setHover(null); }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onSelect(n); }}
        >
          <mesh>
            <boxGeometry args={[0.5, 0.42, 0.06]} />
            <meshStandardMaterial color={hover?.id === n.id ? '#1e2740' : '#0f1526'} metalness={0.7} roughness={0.4} />
          </mesh>
          <mesh position={[0, 0.1, 0.04]}>
            <boxGeometry args={[0.09, 0.09, 0.03]} />
            <meshStandardMaterial color={hexes[n.status]} emissive={hexes[n.status]} emissiveIntensity={emissiveFor(n.status)} toneMapped={false} />
          </mesh>
          <sprite position={[0, 0.1, 0.1]} scale={hover?.id === n.id ? 0.5 : 0.32}>
            <spriteMaterial map={glowTexture()} color={hexes[n.status]} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0.9} />
          </sprite>
          {hover?.id === n.id && <Tooltip node={n} />}
        </group>
      ))}
      <Html position={[0, 0.66, 0]} center distanceFactor={12} className="sv-plate sv-plate-edge" occlude={false}>
        <span className="sv-plate-txt">Edge · Traefik</span>
      </Html>
    </group>
  );
}

// ── the container floor: every node instanced as a status-lit micro-cube ──────
function ContainerFloor({ nodes, hexes }: { nodes: PortalNode[]; hexes: Hexes }) {
  const cells = useMemo(() => {
    const list = nodes.filter((n) => !n.hidden);
    const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
    const rows = Math.max(1, Math.ceil(list.length / cols));
    const sp = 0.82;
    return list.map((n, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      return {
        id: n.id,
        hex: hexes[n.status],
        pos: [
          (c - (cols - 1) / 2) * sp,
          FLOOR_Y,
          FLOOR_Z + (r - (rows - 1) / 2) * sp,
        ] as [number, number, number],
      };
    });
  }, [nodes, hexes]);

  if (!cells.length) return null;
  return (
    <group>
      {/* soft grounding pad (round via alpha map, so it fades into the page) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y - 0.24, FLOOR_Z]}>
        <planeGeometry args={[14, 14]} />
        <meshBasicMaterial color="#0a0f18" transparent opacity={0.5} alphaMap={glowTexture()} depthWrite={false} />
      </mesh>
      <Instances limit={512} range={cells.length}>
        <boxGeometry args={[0.42, 0.42, 0.42]} />
        <meshStandardMaterial metalness={0.3} roughness={0.55} emissiveIntensity={0.6} toneMapped={false} />
        {cells.map((c) => (
          <Instance key={c.id} position={c.pos} color={c.hex} />
        ))}
      </Instances>
    </group>
  );
}

// ── camera focus + gentle idle orbit; OrbitControls owns drag + wheel-zoom ────
function Rig({
  focus, presets, animate,
}: {
  focus: Focus;
  presets: Record<Focus, { pos: THREE.Vector3; target: THREE.Vector3 }>;
  animate: boolean;
}) {
  const { camera, gl } = useThree();
  const controls = useRef<any>(null);
  const anim = useRef({ active: false, pos: new THREE.Vector3(), target: new THREE.Vector3() });
  const now = useRef(0);          // live elapsed time, so event handlers can read it
  const resumeAt = useRef(0);     // elapsed time after which idle orbit may resume
  const paused = useRef(false);   // true while the user is actively driving

  // On focus change, arm a smooth fly-to.
  useEffect(() => {
    const p = presets[focus];
    if (!p) return;
    anim.current.pos.copy(p.pos);
    anim.current.target.copy(p.target);
    anim.current.active = true;
  }, [focus, presets]);

  // Seed the initial framing once controls exist.
  useEffect(() => {
    const p = presets.projects;
    camera.position.copy(p.pos);
    if (controls.current) {
      controls.current.target.copy(p.target);
      controls.current.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pan with Shift/Ctrl(+Cmd) + scroll — move along the screen's right/up axes.
  // Plain scroll falls through to OrbitControls (zoom). Capture phase +
  // stopImmediatePropagation so the modifier scroll never also zooms; passive:
  // false so we can preventDefault the browser's ctrl-wheel page zoom.
  useEffect(() => {
    const el = gl.domElement;
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const move = new THREE.Vector3();
    const onWheel = (e: WheelEvent) => {
      if (!(e.shiftKey || e.ctrlKey || e.metaKey)) return; // plain wheel → zoom
      e.preventDefault();
      e.stopImmediatePropagation();
      const c = controls.current;
      if (!c) return;
      anim.current.active = false;
      resumeAt.current = now.current + 2.4; // hold the idle orbit while panning
      const dist = camera.position.distanceTo(c.target);
      const step = (e.deltaY || 0) * dist * 0.0016;
      right.setFromMatrixColumn(camera.matrix, 0); // camera's screen-right
      up.setFromMatrixColumn(camera.matrix, 1); // camera's screen-up
      move.set(0, 0, 0);
      if (e.shiftKey) move.addScaledVector(right, step); // sides
      else move.addScaledVector(up, -step); // ctrl / cmd → up + down
      camera.position.add(move);
      c.target.add(move);
      c.update();
    };
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => el.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, camera]);

  useFrame((state) => {
    now.current = state.clock.elapsedTime;
    const c = controls.current;
    if (!c) return;
    if (anim.current.active) {
      camera.position.lerp(anim.current.pos, 0.08);
      c.target.lerp(anim.current.target, 0.08);
      c.update();
      if (camera.position.distanceTo(anim.current.pos) < 0.06) anim.current.active = false;
      return;
    }
    // Idle auto-orbit — a slow azimuth drift that pauses while the user drives.
    if (animate && !paused.current && now.current >= resumeAt.current) {
      const off = new THREE.Vector3().subVectors(camera.position, c.target);
      const a = 0.0016;
      const nx = off.x * Math.cos(a) - off.z * Math.sin(a);
      const nz = off.x * Math.sin(a) + off.z * Math.cos(a);
      off.x = nx; off.z = nz;
      camera.position.copy(c.target).add(off);
      c.update();
    }
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enablePan
      screenSpacePanning
      panSpeed={0.9}
      enableDamping
      dampingFactor={0.08}
      minDistance={4}
      maxDistance={44}
      minPolarAngle={0.2}
      maxPolarAngle={1.52}
      onStart={() => { anim.current.active = false; paused.current = true; }}
      onEnd={() => { paused.current = false; resumeAt.current = now.current + 2.4; }}
    />
  );
}

function Scene({
  panels, nodes, focus, animate,
}: {
  panels: Panel[];
  nodes: PortalNode[];
  focus: Focus;
  animate: boolean;
}) {
  const navigate = useNavigate();
  const [hover, setHover] = useState<Hover>(null);
  const groupRef = useRef<THREE.Group>(null);

  // Pointer feedback: anything hoverable is clickable → cursor pointer.
  useEffect(() => {
    document.body.style.cursor = hover ? 'pointer' : '';
    return () => { document.body.style.cursor = ''; };
  }, [hover]);

  const hexes = useMemo<Hexes>(() => statusHexes(), []);
  const primary = useMemo(() => cssVar('--primary') || '#4d9bff', []);

  const edgePanel = panels.find((p) => p.key === 'infra');
  const rackPanels = panels.filter((p) => p.key !== 'infra');

  const startX = -((Math.max(1, rackPanels.length) - 1) * RACK_PITCH) / 2;
  const spanX = Math.max(RACK_PITCH, rackPanels.length * RACK_PITCH);
  const maxUnits = Math.max(1, ...rackPanels.map((p) => Math.min(p.nodes.length, MAX_UNITS)));
  const topY = rackPostH(maxUnits);
  const edgeWidth = Math.max(6, spanX * 0.82);
  const edgeY = topY + 1.3;

  const onSelect = (n: PortalNode) => navigate(serviceLink(n));

  const presets = useMemo<Record<Focus, { pos: THREE.Vector3; target: THREE.Vector3 }>>(() => ({
    projects: {
      pos: new THREE.Vector3(spanX * 0.16, topY * 0.55 + 1.4, spanX * 0.82 + 7.5),
      target: new THREE.Vector3(0, topY * 0.46, 0),
    },
    edge: {
      pos: new THREE.Vector3(0, edgeY + 1.4, edgeWidth * 0.62 + 4),
      target: new THREE.Vector3(0, edgeY, 0),
    },
    containers: {
      pos: new THREE.Vector3(spanX * 0.2, 5.2, spanX * 0.5 + 9.5),
      target: new THREE.Vector3(0, FLOOR_Y + 0.3, FLOOR_Z),
    },
  }), [spanX, topY, edgeY, edgeWidth]);

  return (
    <>
      <ambientLight intensity={0.55} />
      <hemisphereLight intensity={0.35} color="#cfe0ff" groundColor="#0a0e16" />
      <directionalLight position={[6, 14, 9]} intensity={1.5} color="#dbe7ff" />
      <pointLight position={[-7, 7, -5]} intensity={45} distance={45} color={primary} />
      <pointLight position={[0, 3, 12]} intensity={16} distance={40} color="#22d3ee" />

      <Rig focus={focus} presets={presets} animate={animate} />

      <group ref={groupRef}>
        {edgePanel && (
          <EdgeBar
            panel={edgePanel}
            width={edgeWidth}
            y={edgeY}
            hexes={hexes}
            hover={hover}
            setHover={setHover}
            onSelect={onSelect}
            primary={primary}
          />
        )}
        {rackPanels.map((p, i) => (
          <Rack
            key={p.key}
            panel={p}
            x={startX + i * RACK_PITCH}
            hexes={hexes}
            hover={hover}
            setHover={setHover}
            onSelect={onSelect}
          />
        ))}
        <ContainerFloor nodes={nodes} hexes={hexes} />
      </group>
    </>
  );
}

// ── the framed, self-contained viewport ──────────────────────────────────────
const FOCI: { key: Focus; label: string }[] = [
  { key: 'edge', label: 'Edge' },
  { key: 'projects', label: 'Projects' },
  { key: 'containers', label: 'Containers' },
];

function Viewport({ nodes }: { nodes: PortalNode[] }) {
  const [ok] = useState(() => hasWebGL());
  const [reduced] = useState(() => prefersReducedMotion());
  const [focus, setFocus] = useState<Focus>('projects');
  const panels = useMemo(() => panelize(nodes), [nodes]);
  const hasEdge = panels.some((p) => p.key === 'infra');

  if (!ok || reduced) {
    return (
      <div className="sv-frame">
        <div className="sv-frame-h">
          <span className="sv-frame-title">Live stack</span>
          <span className="sv-frame-note">{ok ? 'reduced motion' : 'static view'}</span>
        </div>
        <div className="sv-viewport sv-viewport-static">
          <StaticStack nodes={nodes} />
        </div>
      </div>
    );
  }

  return (
    <div className="sv-frame">
      <div className="sv-frame-h">
        <span className="sv-frame-title">Live stack</span>
        <div className="sv-focus" role="group" aria-label="Camera focus">
          {FOCI.filter((f) => f.key !== 'edge' || hasEdge).map((f) => (
            <button
              key={f.key}
              type="button"
              className={`sv-focus-btn${focus === f.key ? ' is-on' : ''}`}
              aria-pressed={focus === f.key}
              onClick={() => setFocus(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sv-viewport">
        <Canvas
          dpr={[1, 1.75]}
          gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
          onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
          camera={{ position: [0, 6, 18], fov: 42 }}
          onPointerMissed={() => { /* click on empty space: no-op */ }}
        >
          <Scene panels={panels} nodes={nodes} focus={focus} animate={!reduced} />
        </Canvas>

        <div className="sv-vignette" aria-hidden="true" />
        <div className="sv-legend" aria-hidden="true">
          {(['up', 'starting', 'down', 'unknown'] as Status[]).map((s) => (
            <span key={s} className="sv-leg">
              <span className="sv-leg-dot" style={{ ['--led' as string]: STATUS_HEX[s] }} />
              {STATUS_LABEL[s]}
            </span>
          ))}
        </div>
        <div className="sv-hint" aria-hidden="true">drag to orbit · scroll to zoom · shift / ctrl-scroll to pan · click a unit</div>
      </div>
    </div>
  );
}

// Public, self-contained: reads the shared poll itself, needs no props. This is
// the interface the Overview places (`<StackViewport />`).
export function StackViewport() {
  const { data } = usePortal();
  return <Viewport nodes={data.nodes} />;
}

// Back-compat wrapper: the previous Overview mounted <StackScene nodes={…} />.
// Kept so the app compiles whichever call-site the integrator wires up.
export function StackScene({ nodes }: { nodes: PortalNode[] }) {
  return <Viewport nodes={nodes} />;
}
