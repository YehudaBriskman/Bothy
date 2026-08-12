import { Link, useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import type { PortalNode } from '../lib/discover';
import { ServiceIcon, StatusIcon } from '../lib/icons';
import { serviceLink, nodeSub, kindLabelOf, unknownReason } from '../lib/links';

// The dense table row - the manager's default when there are ~40 services and
// cards would overwhelm. The WHOLE row navigates to detail (the name is still a
// real <Link> for keyboard/right-click); the external-link cell and the name
// link stop propagation so they keep their own behaviour.
//
// Status comes from node.status and NOTHING else. It used to be
// `probed ?? node.status`, while the page's rollups and chips read node.status -
// so a page could report "0/3 up · Unknown 3" above three rows all showing "Up".
export function ServiceRow({ node, showGroup = true }: { node: PortalNode; showGroup?: boolean }) {
  const navigate = useNavigate();
  const kind = kindLabelOf(node);

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
      <td>
        <StatusIcon
          status={node.status}
          showLabel
          title={node.container?.statusText || unknownReason(node) || node.status}
        />
      </td>
      {showGroup && <td className="mono">{node.group}</td>}
      <td><span className={`tag ${kind.bad ? 'bad' : ''}`} title={kind.hint}>{kind.label}</span></td>
      <td className="mono">{node.ports.map((p) => p.hostPort).join(', ') || '-'}</td>
      <td className="mono svc-td-img">{node.container?.image || '-'}</td>
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
