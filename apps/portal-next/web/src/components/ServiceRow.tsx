import { Link, useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import type { PortalNode, Status } from '../lib/discover';
import { ServiceIcon, StatusIcon } from '../lib/icons';
import { serviceLink, nodeSub } from '../lib/links';

// The dense table row — the manager's default when there are ~40 services and
// cards would overwhelm. The WHOLE row navigates to detail (the name is still a
// real <Link> for keyboard/right-click); the external-link cell and the name
// link stop propagation so they keep their own behaviour.
export function ServiceRow({ node, probed }: { node: PortalNode; probed?: Status }) {
  const navigate = useNavigate();
  const status = probed ?? node.status;
  const kindLabel =
    node.route?.provider === 'file' ? 'host'
    : node.kind === 'orphan-route' ? 'orphan'
    : node.kind === 'unrouted' ? 'unrouted'
    : 'routed';

  return (
    <tr className="svc-tr" onClick={() => navigate(serviceLink(node))}>
      <td className="svc-td-name">
        <Link to={serviceLink(node)} className="svc-td-link" onClick={(e) => e.stopPropagation()}>
          <span className="ico sm"><ServiceIcon node={node} size={15} /></span>
          <span className="svc-td-text">
            <span className="nm-text">{node.name}</span>
            <span className="pt">{nodeSub(node)}</span>
          </span>
        </Link>
      </td>
      <td><StatusIcon status={status} showLabel title={node.container?.statusText || status} /></td>
      <td className="mono">{node.group}</td>
      <td><span className={`tag ${kindLabel === 'orphan' ? 'bad' : ''}`}>{kindLabel}</span></td>
      <td className="mono">{node.ports.map((p) => p.hostPort).join(', ') || '—'}</td>
      <td className="mono svc-td-img">{node.container?.image || '—'}</td>
      <td className="svc-td-open">
        {node.browsable && node.url ? (
          <a href={node.url} target="_blank" rel="noopener noreferrer" title={node.url} onClick={(e) => e.stopPropagation()}>
            <ExternalLink size={15} />
          </a>
        ) : null}
      </td>
    </tr>
  );
}
