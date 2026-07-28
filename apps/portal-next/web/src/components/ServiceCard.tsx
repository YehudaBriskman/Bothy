import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ExternalLink } from 'lucide-react';
import { HOST_OVERRIDES, type PortalNode, type Status } from '../lib/discover';
import { ServiceIcon, StatusIcon } from '../lib/icons';
import { serviceLink, nodeSub } from '../lib/links';

// framer-motion-wrapped Link: the whole card is the navigation target AND the
// animating unit (layout re-order on filter, hover lift). Defined at module
// scope so its component identity is stable across renders.
const MotionLink = motion(Link);

// A service card for the manager grid. The WHOLE card links to the service
// detail page; a separate "open" pill launches the live URL in a new tab (only
// when browsable — clicking postgres/redis/s3 in a browser is never wanted).
// Status is shown as FORM (a distinct glyph per state) + a label, never colour
// alone. Cards are equal-height (see Services.css) so ~40 of them stay scannable.
export function ServiceCard({
  node, probed, compact = false, reduced = false,
}: {
  node: PortalNode; probed?: Status; compact?: boolean; reduced?: boolean;
}) {
  const status = probed ?? node.status;
  const desc = HOST_OVERRIDES[node.host ?? '']?.desc || node.desc;
  const openable = node.browsable && !!node.url;

  const badge =
    node.route?.provider === 'file' ? <span className="tag">host process</span>
    : node.kind === 'orphan-route' && node.route?.provider === 'docker' ? <span className="tag bad">no container</span>
    : node.kind === 'orphan-route' ? <span className="tag bad">orphan route</span>
    : node.kind === 'unrouted' ? <span className="tag">unrouted</span>
    : null;

  return (
    <MotionLink
      to={serviceLink(node)}
      className={`svc-card ${compact ? 'compact' : ''}`}
      data-state={status}
      layout={!reduced}
      initial={reduced ? false : { opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
      whileHover={reduced ? undefined : { y: -3 }}
      transition={{ type: 'spring', stiffness: 460, damping: 36, mass: 0.7 }}
    >
      <div className="svc-card-top">
        <span className="ico"><ServiceIcon node={node} size={compact ? 17 : 20} /></span>
        <div className="svc-meta">
          <div className="nm">
            <span className="nm-text">{node.name}</span>
          </div>
          <div className="pt">{nodeSub(node)}</div>
        </div>
        <StatusIcon status={status} size={compact ? 15 : 16} showLabel={!compact} title={node.container?.statusText || status} />
      </div>

      {!compact && <div className="svc-desc">{desc}</div>}

      <div className="svc-foot">
        <span className="svc-card-group">{node.group}</span>
        <span className="svc-foot-right">
          {badge}
          {openable ? (
            <a
              className="open-pill"
              href={node.url!}
              target="_blank"
              rel="noopener noreferrer"
              title={node.url!}
              onClick={(e) => e.stopPropagation()}
            >
              Open <ExternalLink size={13} />
            </a>
          ) : node.ports.length ? (
            <span className="svc-note">{(node.ports[0].proto || '').toUpperCase()} · not a web UI</span>
          ) : (
            <span className="svc-note">detail →</span>
          )}
        </span>
      </div>
    </MotionLink>
  );
}
