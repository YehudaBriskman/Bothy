import { Link, useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import type { PortalNode } from '../lib/discover';
import { ServiceIcon, StatusIcon } from '../lib/icons';
import { serviceLink, nodeSub, kindLabelOf, unknownReason } from '../lib/links';
import { ActionCell } from './ServiceActions';

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
      {/* The group's DISPLAY name, not its compose slug. This cell printed
          `node.group` and so read `auth` while the Overview called the same
          system `Identity · Keycloak` - the rename reached one surface out of
          three. `groupTitle` is resolved once in discovery, so every surface
          now agrees by construction rather than by remembering. */}
      {showGroup && <td>{node.groupTitle}</td>}
      <td><span className={`tag ${kind.bad ? 'bad' : ''}`} title={kind.hint}>{kind.label}</span></td>
      <td className="mono">{node.ports.map((p) => p.hostPort).join(', ') || '-'}</td>
      <td className="mono svc-td-img">{node.container?.image || '-'}</td>
      {/* The action control. BEFORE the open-in-new cell rather than after it,
          because "act on this" and "go to this" are different kinds of thing and
          the row should not end on two adjacent icons that both look like exits.
          It renders nothing at all when there is no container behind the row. */}
      <td className="svc-td-act" onClick={(e) => e.stopPropagation()}>
        <ActionCell node={node} />
      </td>
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
