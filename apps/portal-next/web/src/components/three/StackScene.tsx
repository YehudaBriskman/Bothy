import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeElements } from '@react-three/fiber';
import { Html, OrbitControls, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { useNavigate } from 'react-router-dom';
import { usePortal } from '../../lib/data';
import { panelize, type Panel } from '../../lib/panels';
import type { PortalNode, Status, ServiceType } from '../../lib/discover';
import { serviceLink } from '../../lib/links';
import { ServiceIcon, StatusIcon } from '../../lib/icons';
import {
  hasWebGL, prefersReducedMotion, statusHexes, cssVar, scenePalette,
  type ScenePalette,
} from './webgl';

import { StaticStack } from './StaticStack';
import './three.css';

// The scene's structural materials, theme-aware. React context (not props)
// because the palette is needed several levels down in half a dozen meshes, and
// the provider lives INSIDE the Canvas so react-three-fiber's separate
// reconciler can see it.
const PaletteCtx = createContext<ScenePalette>(scenePalette());
const usePal = () => useContext(PaletteCtx);

// "The theme changed" as one subscription, counted rather than valued.
//
// This used to live inside useScenePalette and serve only the ScenePalette, so
// the two OTHER things this scene reads from the theme - the status LED hexes
// and the accent that lights it - were `useMemo(..., [])` and were read exactly
// once, at mount. Flipping the theme repainted the chassis and left the lights
// and the LEDs on the old palette. A tick shared by all three is what makes
// "reads a token" and "follows the theme" the same statement.
function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', bump);
    return () => { mo.disconnect(); mq.removeEventListener('change', bump); };
  }, []);
  return tick;
}

// ── layout constants (world units; 1U slab ≈ 0.5 tall) ───────────────────────
const SLAB_W = 2.2;
const SLAB_H = 0.5;
const SLAB_D = 1.3;
const SLAB_PITCH = 0.6; // slab height + gap
const RW = SLAB_W + 0.5; // rack outer width
const RD = SLAB_D + 0.4; // rack outer depth
const RACK_PITCH = RW + 1.0; // centre-to-centre spacing of racks
const MAX_UNITS = 14; // cap detail per rack
const MAX_FLOOR = 40; // cap labelled floor machines
const FLOOR_Y = -0.9;
const FLOOR_Z = RD / 2 + 3.0;

type Hexes = Record<Status, string>;
type Focus = 'edge' | 'projects' | 'containers';
type Hover = { id: string; node: PortalNode } | null;

const rackPostH = (count: number) => Math.max(1, count) * SLAB_PITCH + 0.7;
const emissiveFor = (s: Status) => (s === 'up' ? 0.9 : s === 'unknown' ? 0.3 : 1.35);

// Decorative per-type accent (3D only - not a text/surface token, so a literal
// palette is fine here; it just tints a slab's spine + a machine's band).
const TYPE_TINT: Record<ServiceType, string> = {
  web: '#4d9bff',
  database: '#a78bfa',
  cache: '#f472b6',
  queue: '#22d3ee',
  storage: '#f59e0b',
  observability: '#34d399',
  edge: '#818cf8',
  runtime: '#94a3b8',
  other: '#7c8aa3',
};

// The short, human half of a display name ("CVOps · Postgres" → "Postgres").
const shortName = (n: PortalNode) => {
  const parts = n.name.split('·');
  return (parts[parts.length - 1] || n.name).trim();
};

// Aggregate a set of nodes to a single worst-first status (drives cable colour).
function aggStatus(nodes: PortalNode[]): Status {
  if (nodes.some((n) => n.status === 'down')) return 'down';
  if (nodes.some((n) => n.status === 'starting')) return 'starting';
  if (nodes.some((n) => n.status === 'up')) return 'up';
  return 'unknown';
}

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

// ── offline billboard text labels ────────────────────────────────────────────
// drei <Text>/troika would fetch a Roboto font from a CDN - forbidden here (the
// app runs offline behind SSO). So every machine label is a cheap GPU sprite of a
// canvas-rendered pill: no DOM cost, no network, billboards to the camera for
// free. Textures are cached by string so repeated names cost one canvas each.
interface LabelTex { tex: THREE.Texture; aspect: number; }
const _labelCache = new Map<string, LabelTex>();
function labelTexture(text: string): LabelTex {
  const hit = _labelCache.get(text);
  if (hit) return hit;
  const fontPx = 40;
  const padX = 20;
  const padY = 12;
  const font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const meas = document.createElement('canvas').getContext('2d')!;
  meas.font = font;
  const tw = Math.ceil(meas.measureText(text).width);
  const w = tw + padX * 2;
  const h = fontPx + padY * 2;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.font = font;
  // rounded pill background - dark + subtle stroke so it reads on light or dark
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(10,14,23,0.82)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(150,170,205,0.28)';
  ctx.stroke();
  ctx.fillStyle = '#e8eef8';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2 + 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  const res: LabelTex = { tex, aspect: w / h };
  _labelCache.set(text, res);
  return res;
}

type GroupProps = ThreeElements['group'];

function TagSprite({ text, position, height = 0.16 }: { text: string; position: [number, number, number]; height?: number }) {
  const { tex, aspect } = useMemo(() => labelTexture(text), [text]);
  return (
    <sprite position={position} scale={[height * aspect, height, 1]} renderOrder={12}>
      <spriteMaterial map={tex} transparent depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

// ── one 1U server slab: metal chassis, bezel, vents, screen, LED array, tag ────
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
      grp.current.position.z = THREE.MathUtils.lerp(grp.current.position.z, hovered ? 0.2 : 0, 0.2);
    }
  });
  const emis = emissiveFor(node.status);
  const tint = TYPE_TINT[node.serviceType];
  const front = SLAB_D / 2 + 0.012;
  const pal = usePal();

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
          <meshStandardMaterial color={hovered ? pal.slabBodyHover : pal.slabBody} metalness={0.85} roughness={0.34} />
        </RoundedBox>
        {/* brushed front bezel, slightly proud */}
        <mesh position={[0, 0, SLAB_D / 2 + 0.001]}>
          <planeGeometry args={[SLAB_W - 0.05, SLAB_H - 0.06]} />
          <meshStandardMaterial color={pal.slab} metalness={0.6} roughness={0.48} />
        </mesh>
        {/* type-accent spine down the left edge */}
        <mesh position={[-SLAB_W / 2 + 0.05, 0, front]}>
          <boxGeometry args={[0.05, SLAB_H - 0.08, 0.02]} />
          <meshStandardMaterial color={tint} emissive={tint} emissiveIntensity={0.65} toneMapped={false} />
        </mesh>
        {/* vent slits, left third - two banks */}
        {[0, 1, 2, 3, 4].map((i) => (
          <mesh key={i} position={[-SLAB_W / 2 + 0.42, SLAB_H / 2 - 0.1 - i * 0.07, front]}>
            <boxGeometry args={[0.6, 0.024, 0.012]} />
            <meshStandardMaterial color={pal.vent} roughness={0.95} />
          </mesh>
        ))}
        {/* little service screen (glows faintly) */}
        <mesh position={[-0.12, 0, front]}>
          <planeGeometry args={[0.5, 0.24]} />
          <meshStandardMaterial color={pal.slabScreen} emissive={pal.slabGlow} emissiveIntensity={0.5} metalness={0.2} roughness={0.35} toneMapped={false} />
        </mesh>
        {/* drive handle, right */}
        <mesh position={[SLAB_W / 2 - 0.55, 0, SLAB_D / 2 + 0.03]}>
          <boxGeometry args={[0.5, 0.14, 0.05]} />
          <meshStandardMaterial color={pal.handle} metalness={0.75} roughness={0.4} />
        </mesh>
        {/* indicator array - three faint activity LEDs */}
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[SLAB_W / 2 - 0.16 - i * 0.14, -SLAB_H / 2 + 0.12, front + 0.008]}>
            <boxGeometry args={[0.06, 0.06, 0.02]} />
            <meshStandardMaterial color={pal.activity} emissive={pal.activity} emissiveIntensity={0.55} toneMapped={false} />
          </mesh>
        ))}
        {/* status LED + additive glow, top-right */}
        <mesh position={[SLAB_W / 2 - 0.16, SLAB_H / 2 - 0.12, front + 0.008]}>
          <boxGeometry args={[0.1, 0.1, 0.03]} />
          <meshStandardMaterial color={colorHex} emissive={colorHex} emissiveIntensity={emis} toneMapped={false} />
        </mesh>
        <sprite position={[SLAB_W / 2 - 0.16, SLAB_H / 2 - 0.12, front + 0.08]} scale={hovered ? 0.58 : 0.38}>
          <spriteMaterial map={glowTexture()} color={colorHex} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0.9} />
        </sprite>

        {/* always-on name tag, floating just in front of the slab */}
        <TagSprite text={shortName(node)} position={[0, 0, SLAB_D / 2 + 0.34]} height={0.17} />

        {hovered && <Tooltip node={node} />}
      </group>
    </group>
  );
}

// drei <Html> tooltip anchored to the slab (tracks orbit); crisp, screen-sized.
function Tooltip({ node }: { node: PortalNode }) {
  return (
    <Html position={[0, SLAB_H / 2 + 0.16, SLAB_D / 2 + 0.05]} center zIndexRange={[120, 0]} className="sv-tip" occlude={false}>
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
  const pal = usePal();
  const units = panel.nodes.slice(0, MAX_UNITS);
  const postH = rackPostH(units.length);
  const frameMat = <meshStandardMaterial color={pal.frame} metalness={0.9} roughness={0.28} />;
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
        <meshStandardMaterial color={pal.backPanel} metalness={0.6} roughness={0.6} side={THREE.DoubleSide} />
      </mesh>
      {/* front mounting rails */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (SLAB_W / 2 + 0.06), postH / 2, RD / 2 - 0.02]}>
          <boxGeometry args={[0.05, postH - 0.2, 0.05]} />
          <meshStandardMaterial color={pal.rail} metalness={0.8} roughness={0.4} />
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

// ── the edge/Traefik unit - a wide, high-presence bar above the racks ─────────
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
  const nodes = panel.nodes.slice(0, 10);
  const span = width - 1.4;
  const step = nodes.length > 1 ? span / (nodes.length - 1) : 0;
  const start = -span / 2;
  const front = (RD + 0.6) / 2 + 0.01;
  const H = 1.0;
  const pal = usePal();
  return (
    <group position={[0, y, 0]}>
      {/* main chassis - taller + deeper than a slab, reads as the trunk */}
      <RoundedBox args={[width, H, RD + 0.6]} radius={0.06} smoothness={3}>
        <meshStandardMaterial color={pal.chassis} metalness={0.88} roughness={0.3} emissive={primary} emissiveIntensity={0.16} />
      </RoundedBox>
      {/* front bezel */}
      <mesh position={[0, 0, front]}>
        <planeGeometry args={[width - 0.12, H - 0.12]} />
        <meshStandardMaterial color={pal.bezel} metalness={0.55} roughness={0.5} />
      </mesh>
      {/* top vent grille */}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <mesh key={i} position={[0, H / 2 + 0.001, -RD / 2 + 0.2 + i * 0.14]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[width - 0.6, 0.05]} />
          <meshStandardMaterial color={pal.vent} roughness={0.95} />
        </mesh>
      ))}
      {/* glowing accent stripe across the face */}
      <mesh position={[0, 0.28, front + 0.001]}>
        <planeGeometry args={[width - 0.3, 0.06]} />
        <meshStandardMaterial color={primary} emissive={primary} emissiveIntensity={1.6} toneMapped={false} />
      </mesh>
      {/* under-glow plane - gives the edge a lit halo beneath it */}
      <sprite position={[0, -H / 2 - 0.1, front - 0.2]} scale={[width * 0.9, 1.1, 1]}>
        <spriteMaterial map={glowTexture()} color={primary} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0.4} />
      </sprite>
      {/* rack-style feet */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (width / 2 - 0.5), -H / 2 - 0.08, 0]}>
          <boxGeometry args={[0.5, 0.16, RD]} />
          <meshStandardMaterial color={pal.frame} metalness={0.9} roughness={0.3} />
        </mesh>
      ))}

      {/* one clickable module per edge node - mini bezel + screen + LED */}
      {nodes.map((n, i) => (
        <group
          key={n.id}
          position={[start + i * step, -0.08, front + 0.02]}
          onPointerOver={(e) => { e.stopPropagation(); setHover({ id: n.id, node: n }); }}
          onPointerOut={(e) => { e.stopPropagation(); setHover(null); }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onSelect(n); }}
        >
          <mesh>
            <boxGeometry args={[0.54, 0.5, 0.07]} />
            <meshStandardMaterial color={hover?.id === n.id ? pal.unitHover : pal.unit} metalness={0.7} roughness={0.4} />
          </mesh>
          <mesh position={[0, -0.1, 0.045]}>
            <planeGeometry args={[0.4, 0.14]} />
            <meshStandardMaterial color={pal.screen} emissive={pal.screenGlow} emissiveIntensity={0.5} toneMapped={false} />
          </mesh>
          <mesh position={[0, 0.13, 0.045]}>
            <boxGeometry args={[0.1, 0.1, 0.03]} />
            <meshStandardMaterial color={hexes[n.status]} emissive={hexes[n.status]} emissiveIntensity={emissiveFor(n.status)} toneMapped={false} />
          </mesh>
          <sprite position={[0, 0.13, 0.11]} scale={hover?.id === n.id ? 0.54 : 0.36}>
            <spriteMaterial map={glowTexture()} color={hexes[n.status]} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0.9} />
          </sprite>
          {hover?.id === n.id && <Tooltip node={n} />}
        </group>
      ))}
      <Html position={[0, H / 2 + 0.34, 0]} center distanceFactor={12} className="sv-plate sv-plate-edge" occlude={false}>
        <span className="sv-plate-txt">Edge · Traefik</span>
      </Html>
    </group>
  );
}

// ── one energy cable: a status-tinted tube with a pulse gliding along it ───────
const _pulsePt = new THREE.Vector3();
function Cable({
  curve, hex, animate, offset,
}: {
  curve: THREE.Curve<THREE.Vector3>;
  hex: string;
  animate: boolean;
  offset: number;
}) {
  const geom = useMemo(() => new THREE.TubeGeometry(curve, 44, 0.035, 8, false), [curve]);
  useEffect(() => () => geom.dispose(), [geom]);
  const pulse = useRef<THREE.Sprite>(null);
  const staticPt = useMemo(() => curve.getPoint(0.5), [curve]);

  useFrame((state) => {
    if (!animate || !pulse.current) return;
    const t = (state.clock.elapsedTime * 0.26 + offset) % 1;
    curve.getPoint(t, _pulsePt);
    pulse.current.position.copy(_pulsePt);
  });

  return (
    <group>
      <mesh geometry={geom}>
        <meshStandardMaterial
          color={hex}
          emissive={hex}
          emissiveIntensity={0.5}
          metalness={0.2}
          roughness={0.6}
          transparent
          opacity={0.62}
          toneMapped={false}
        />
      </mesh>
      <sprite
        ref={pulse}
        position={animate ? [0, 0, 0] : [staticPt.x, staticPt.y, staticPt.z]}
        scale={0.55}
      >
        <spriteMaterial map={glowTexture()} color={hex} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0.95} />
      </sprite>
    </group>
  );
}

// ── the cable harness: edge → each rack, and each rack → the container floor ───
function Cables({
  edgeY, racks, hexes, floorZ, animate,
}: {
  edgeY: number;
  racks: { x: number; topY: number; status: Status }[];
  hexes: Hexes;
  floorZ: number;
  animate: boolean;
}) {
  const cables = useMemo(() => {
    const out: { key: string; curve: THREE.Curve<THREE.Vector3>; hex: string; offset: number }[] = [];
    racks.forEach((r, i) => {
      // edge → rack top: drop out of the edge, arc across, settle onto the rack
      const a = new THREE.Vector3(r.x * 0.28, edgeY - 0.55, 0.2);
      const b = new THREE.Vector3(r.x * 0.6, edgeY - 1.1, RD / 2 + 0.4);
      const c = new THREE.Vector3(r.x, r.topY + 0.8, RD / 2 + 0.3);
      const d = new THREE.Vector3(r.x, r.topY + 0.16, RD / 2 - 0.05);
      out.push({ key: `e-${i}`, curve: new THREE.CubicBezierCurve3(a, b, c, d), hex: hexes[r.status], offset: i * 0.17 });

      // rack base → container floor: fall to the floor and fan toward the grid
      const p = new THREE.Vector3(r.x, 0.12, RD / 2);
      const q = new THREE.Vector3(r.x, FLOOR_Y + 0.9, RD / 2 + 1.0);
      const s = new THREE.Vector3(r.x * 0.5, FLOOR_Y + 0.35, floorZ - 1.6);
      const t = new THREE.Vector3(r.x * 0.28, FLOOR_Y + 0.24, floorZ - 1.0);
      out.push({ key: `f-${i}`, curve: new THREE.CubicBezierCurve3(p, q, s, t), hex: hexes[r.status], offset: 0.5 + i * 0.17 });
    });
    return out;
  }, [racks, edgeY, hexes, floorZ]);

  return (
    <group>
      {cables.map((c) => (
        <Cable key={c.key} curve={c.curve} hex={c.hex} animate={animate} offset={c.offset} />
      ))}
    </group>
  );
}

// ── one labelled floor machine - a little box that reads as a real node ────────
function FloorMachine({
  node, hex, pos, onHover, onOut, onSelect,
}: {
  node: PortalNode;
  hex: string;
  pos: [number, number, number];
  onHover: () => void;
  onOut: () => void;
  onSelect: () => void;
}) {
  const tint = TYPE_TINT[node.serviceType];
  const pal = usePal();
  return (
    <group
      position={pos}
      onPointerOver={(e) => { e.stopPropagation(); onHover(); }}
      onPointerOut={(e) => { e.stopPropagation(); onOut(); }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
    >
      <RoundedBox args={[0.52, 0.36, 0.52]} radius={0.04} smoothness={2}>
        <meshStandardMaterial color={pal.machine} metalness={0.65} roughness={0.4} />
      </RoundedBox>
      {/* type-accent band across the front */}
      <mesh position={[0, -0.02, 0.261]}>
        <boxGeometry args={[0.52, 0.07, 0.01]} />
        <meshStandardMaterial color={tint} emissive={tint} emissiveIntensity={0.7} toneMapped={false} />
      </mesh>
      {/* top vents */}
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[0, 0.181, -0.14 + i * 0.14]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.34, 0.03]} />
          <meshStandardMaterial color={pal.vent} roughness={0.95} />
        </mesh>
      ))}
      {/* status LED + glow */}
      <mesh position={[0.17, 0.19, 0.17]}>
        <boxGeometry args={[0.08, 0.03, 0.08]} />
        <meshStandardMaterial color={hex} emissive={hex} emissiveIntensity={emissiveFor(node.status)} toneMapped={false} />
      </mesh>
      <sprite position={[0.17, 0.22, 0.17]} scale={0.34}>
        <spriteMaterial map={glowTexture()} color={hex} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0.85} />
      </sprite>
      <TagSprite text={shortName(node)} position={[0, 0.44, 0]} height={0.15} />
    </group>
  );
}

// ── the container floor: every node as a labelled micro-machine on a grid ──────
function ContainerFloor({
  nodes, hexes, setHover, onSelect,
}: {
  nodes: PortalNode[];
  hexes: Hexes;
  setHover: (h: Hover) => void;
  onSelect: (n: PortalNode) => void;
}) {
  const cells = useMemo(() => {
    const list = nodes.filter((n) => !n.hidden).slice(0, MAX_FLOOR);
    const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
    const rows = Math.max(1, Math.ceil(list.length / cols));
    const sp = 0.95;
    return list.map((n, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      return {
        node: n,
        hex: hexes[n.status],
        pos: [
          (c - (cols - 1) / 2) * sp,
          FLOOR_Y,
          FLOOR_Z + (r - (rows - 1) / 2) * sp,
        ] as [number, number, number],
      };
    });
  }, [nodes, hexes]);
  const pal = usePal();

  if (!cells.length) return null;
  return (
    <group>
      {/* soft grounding pad (round via alpha map, so it fades into the page) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y - 0.24, FLOOR_Z]}>
        <planeGeometry args={[16, 16]} />
        <meshBasicMaterial color={pal.pad} transparent opacity={pal.padOpacity} alphaMap={glowTexture()} depthWrite={false} />
      </mesh>
      {cells.map((c) => (
        <FloorMachine
          key={c.node.id}
          node={c.node}
          hex={c.hex}
          pos={c.pos}
          onHover={() => setHover({ id: c.node.id, node: c.node })}
          onOut={() => setHover(null)}
          onSelect={() => onSelect(c.node)}
        />
      ))}
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

  // Pan with Shift/Ctrl(+Cmd) + scroll - move along the screen's right/up axes.
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
    // Idle auto-orbit - a slow azimuth drift that pauses while the user drives.
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
      maxDistance={48}
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

  // All three read from the theme, so all three share its tick.
  const tick = useThemeTick();
  const hexes = useMemo<Hexes>(() => statusHexes(), [tick]);
  const pal = useMemo<ScenePalette>(() => scenePalette(), [tick]);
  // `--accent`, not `--primary` - the latter was never a token, so this had been
  // pinned to the literal below since the accent palette was replaced, and three
  // point lights plus the rack emissive were still lighting the scene in the old
  // blue. Reading `--accent` is what makes the scene follow a theme at all.
  const primary = useMemo(() => cssVar('--accent') || '#4d9bff', [tick]);

  const edgePanel = panels.find((p) => p.key === 'infra');
  const rackPanels = panels.filter((p) => p.key !== 'infra');

  const startX = -((Math.max(1, rackPanels.length) - 1) * RACK_PITCH) / 2;
  const spanX = Math.max(RACK_PITCH, rackPanels.length * RACK_PITCH);
  const maxUnits = Math.max(1, ...rackPanels.map((p) => Math.min(p.nodes.length, MAX_UNITS)));
  const topY = rackPostH(maxUnits);
  const edgeWidth = Math.max(6.5, spanX * 0.86);
  const edgeY = topY + 1.7;

  const onSelect = (n: PortalNode) => navigate(serviceLink(n));

  // rack anchor points + aggregate status, for the cable harness
  const rackAnchors = useMemo(
    () => rackPanels.map((p, i) => ({
      x: startX + i * RACK_PITCH,
      topY: rackPostH(Math.min(p.nodes.length, MAX_UNITS)),
      status: aggStatus(p.nodes),
    })),
    [rackPanels, startX],
  );

  const presets = useMemo<Record<Focus, { pos: THREE.Vector3; target: THREE.Vector3 }>>(() => ({
    projects: {
      pos: new THREE.Vector3(spanX * 0.16, topY * 0.55 + 1.6, spanX * 0.86 + 8.5),
      target: new THREE.Vector3(0, topY * 0.46, 0.6),
    },
    edge: {
      pos: new THREE.Vector3(0, edgeY + 1.6, edgeWidth * 0.62 + 4.5),
      target: new THREE.Vector3(0, edgeY, 0),
    },
    containers: {
      pos: new THREE.Vector3(spanX * 0.2, 5.6, spanX * 0.5 + 10.5),
      target: new THREE.Vector3(0, FLOOR_Y + 0.3, FLOOR_Z),
    },
  }), [spanX, topY, edgeY, edgeWidth]);

  return (
    <PaletteCtx.Provider value={pal}>
      {/* lighting - raised a notch: brighter key + fill + ambient, plus a rim */}
      <ambientLight intensity={pal.ambient} />
      <hemisphereLight intensity={0.5} color={pal.sky} groundColor={pal.ground} />
      <directionalLight position={[6, 15, 10]} intensity={1.95} color={pal.key} />
      <directionalLight position={[-9, 8, -6]} intensity={0.7} color={pal.fill} />
      <pointLight position={[-7, 8, -5]} intensity={55} distance={50} color={primary} />
      <pointLight position={[0, 3, 13]} intensity={22} distance={44} color={pal.activity} />
      <pointLight position={[0, edgeY, 5]} intensity={16} distance={30} color={primary} />

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
        {edgePanel && rackAnchors.length > 0 && (
          <Cables
            edgeY={edgeY}
            racks={rackAnchors}
            hexes={hexes}
            floorZ={FLOOR_Z}
            animate={animate}
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
        <ContainerFloor nodes={nodes} hexes={hexes} setHover={setHover} onSelect={onSelect} />
      </group>
    </PaletteCtx.Provider>
  );
}

// ── the framed / full-bleed viewport ─────────────────────────────────────────
const FOCI: { key: Focus; label: string }[] = [
  { key: 'edge', label: 'Edge' },
  { key: 'projects', label: 'Projects' },
  { key: 'containers', label: 'Containers' },
];

function Viewport({ nodes, fill = false }: { nodes: PortalNode[]; fill?: boolean }) {
  const [ok] = useState(() => hasWebGL());
  const [reduced] = useState(() => prefersReducedMotion());
  const [focus, setFocus] = useState<Focus>('projects');
  const panels = useMemo(() => panelize(nodes), [nodes]);
  const hasEdge = panels.some((p) => p.key === 'infra');

  if (!ok || reduced) {
    return (
      <div className={`sv-frame${fill ? ' sv-frame-fill' : ''}`}>
        <div className="sv-frame-h">
          <span className="sv-frame-title">Live stack</span>
          <span className="sv-frame-note">{ok ? 'reduced motion' : 'static view'}</span>
        </div>
        <div className={`sv-viewport sv-viewport-static${fill ? ' sv-viewport-fill' : ''}`}>
          <StaticStack nodes={nodes} />
        </div>
      </div>
    );
  }

  return (
    <div className={`sv-frame${fill ? ' sv-frame-fill' : ''}`}>
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

      <div className={`sv-viewport${fill ? ' sv-viewport-fill' : ''}`}>
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
        {/* No legend here - the Topology page header already renders one, and it
            serves the Flat map too. Two legends on one screen is just noise. */}
        <div className="sv-hint">drag to orbit · scroll to zoom · shift / ctrl-scroll to pan · click a unit</div>
      </div>
    </div>
  );
}

// Public, self-contained: reads the shared poll itself, needs no props. This is
// the framed interface the Overview places (`<StackViewport />`).
export function StackViewport() {
  const { data } = usePortal();
  return <Viewport nodes={data.nodes} />;
}

// Back-compat wrapper: the previous Overview mounted <StackScene nodes={…} />.
// Kept so the app compiles whichever call-site the integrator wires up.
export function StackScene({ nodes }: { nodes: PortalNode[] }) {
  return <Viewport nodes={nodes} />;
}

// The Topology page hero - same scene, full-bleed (fills the content height).
// Reads the shared poll itself, so the page just mounts <TopologyScene />.
export function TopologyScene() {
  const { data } = usePortal();
  return <Viewport nodes={data.nodes} fill />;
}
