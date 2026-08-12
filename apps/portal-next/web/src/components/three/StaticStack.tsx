import { panelize } from '../../lib/panels';
import type { PortalNode } from '../../lib/discover';
import { serviceLink } from '../../lib/links';
import { ServiceIcon } from '../../lib/icons';
import { STATUS_HEX, STATUS_LABEL } from './webgl';
import './three.css';

// The no-WebGL / reduced-motion fallback. Not a placeholder: it renders the same
// idea - an edge bar on top, one rack cabinet per project/stack, each holding a
// column of 1U server slabs with a live status LED - as flat, dependency-free
// DOM. The page must never be blank (portal.md) and this must still read as a
// server rack and stay navigable (each slab links to its service).
export function StaticStack({ nodes }: { nodes: PortalNode[] }) {
  const panels = panelize(nodes);
  const edge = panels.find((p) => p.key === 'infra');
  const racks = panels.filter((p) => p.key !== 'infra');

  return (
    <div className="sv-static" role="group" aria-label="Running stack, one rack per project.">
      {edge && (
        <div className="sv-edge-bar">
          <span className="sv-edge-title">Edge · Traefik</span>
          <div className="sv-edge-leds">
            {edge.nodes.map((n) => (
              <span
                key={n.id}
                className="sv-led"
                title={`${n.name} - ${STATUS_LABEL[n.status]}`}
                style={{ ['--led' as string]: STATUS_HEX[n.status] }}
              />
            ))}
          </div>
        </div>
      )}

      <div className="sv-racks">
        {racks.map((p) => (
          <section className="sv-rack" key={p.key}>
            <header className="sv-rack-plate">{p.title}</header>
            <div className="sv-rack-body">
              {p.nodes.slice(0, 16).map((n) => (
                <a
                  className="sv-slab"
                  key={n.id}
                  href={serviceLink(n)}
                  title={`${n.name} - ${STATUS_LABEL[n.status]}`}
                >
                  <span className="sv-slab-vents" aria-hidden="true" />
                  <ServiceIcon node={n} size={13} className="sv-slab-ico" />
                  <span className="sv-slab-name">{n.name}</span>
                  <span
                    className="sv-led sv-led-sm"
                    style={{ ['--led' as string]: STATUS_HEX[n.status] }}
                    aria-hidden="true"
                  />
                </a>
              ))}
              {p.nodes.length > 16 && (
                <span className="sv-slab sv-slab-more">+{p.nodes.length - 16} more</span>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
