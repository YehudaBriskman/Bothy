import { Link } from 'react-router-dom';
import { Star, ExternalLink, HardDrive, Clock, Layers, AlertTriangle } from 'lucide-react';
import type { System } from '../lib/systems';
import { fmtAgo, fmtUptime } from '../lib/systems';
import { systemLink } from '../lib/links';
import { ServiceIcon } from '../lib/icons';
import type { PortalNode } from '../lib/discover';
import './SystemCard.css';

const KIND_LABEL: Record<System['kind'], string> = { project: 'Project', stack: 'Stack', infra: 'Edge' };

// The most representative node for the card glyph: a running, browsable service
// if there is one (that's what the user opens), else the first running node,
// else the first node. Keeps a system's icon stable and meaningful.
function faceNode(s: System): PortalNode | undefined {
  return (
    s.nodes.find((n) => n.status === 'up' && n.browsable) ||
    s.nodes.find((n) => n.status === 'up') ||
    s.nodes[0]
  );
}

export function SystemCard({
  system, isFav, onToggleFav,
}: {
  system: System;
  isFav: boolean;
  onToggleFav: (key: string) => void;
}) {
  const face = faceNode(system);
  const { up, starting, down, unknown, total, running } = system;
  const pct = total ? Math.round((up / total) * 100) : 0;

  return (
    <Link
      to={systemLink(system.key)}
      className={`syscard ${down ? 'has-down' : ''} ${isFav ? 'is-fav' : ''}`}
      style={{ ['--acc' as string]: `var(${system.accent})` } as React.CSSProperties}
    >
      <button
        type="button"
        className={`syscard-fav ${isFav ? 'on' : ''}`}
        aria-pressed={isFav}
        aria-label={isFav ? `Unpin ${system.title}` : `Pin ${system.title}`}
        title={isFav ? 'Unpin' : 'Pin to top'}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleFav(system.key); }}
      >
        <Star size={15} />
      </button>

      <div className="syscard-head">
        <span className="syscard-ico">
          {face ? <ServiceIcon node={face} size={19} /> : <Layers size={19} />}
        </span>
        <span className="syscard-titles">
          <span className="syscard-name">{system.title}</span>
          <span className="syscard-kind">{KIND_LABEL[system.kind]}</span>
        </span>
      </div>

      <div className="syscard-count">
        <span className="syscard-run">{running}</span>
        <span className="syscard-of">/ {total} running</span>
      </div>

      <div className="ov-bar syscard-bar" role="img" aria-label={`${up} up, ${starting} starting, ${down} down of ${total}`}>
        {up > 0 && <span className="seg up" style={{ flex: up }} />}
        {starting > 0 && <span className="seg starting" style={{ flex: starting }} />}
        {down > 0 && <span className="seg down" style={{ flex: down }} />}
        {unknown > 0 && <span className="seg unknown" style={{ flex: unknown }} />}
      </div>

      <div className="syscard-meta">
        <span className="syscard-pct">{pct}% healthy</span>
        {down > 0 && (
          <span className="syscard-tag down"><AlertTriangle size={12} /> {down} down</span>
        )}
        <span className="syscard-spacer" />
        {system.uiLinks.length > 0 && (
          <span className="syscard-chip" title={`${system.uiLinks.length} web UI${system.uiLinks.length > 1 ? 's' : ''}`}>
            <ExternalLink size={12} /> {system.uiLinks.length}
          </span>
        )}
        {system.volumes.length > 0 && (
          <span className="syscard-chip" title={`${system.volumes.length} volume${system.volumes.length > 1 ? 's' : ''}`}>
            <HardDrive size={12} /> {system.volumes.length}
          </span>
        )}
        {system.newestUptime != null && (
          <span className="syscard-chip" title={`newest started ${fmtAgo(system.newestUptime)} · oldest up ${fmtUptime(system.oldestUptime)}`}>
            <Clock size={12} /> {fmtUptime(system.oldestUptime)}
          </span>
        )}
      </div>
    </Link>
  );
}
