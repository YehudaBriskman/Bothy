// Quick links: every published UI on the box, plus the Bothy pages that are not
// already in the Control sidebar two centimetres to the left (drawing Services,
// Ports and Routes again in bigger boxes would be the footprint rule inverted -
// see Control.tsx's old header). One click opens it.
//
// The UIs come from lib/systems.ts uiPorts(), the same source as the Overview's
// "Open a UI" panel: discovery plus the collector's declared projects, so a
// Headlamp or a Tals stack appears when it is published and disappears when it
// is not, without a list here to keep in step. A stopped UI keeps its tile, marked
// stopped, because "it is off" is an answer and a missing tile is a question.

import { Link } from 'react-router-dom';
import {
  ArchiveRestore, ExternalLink, FolderTree, History, LayoutDashboard, Link2, PackageCheck, type LucideIcon,
} from 'lucide-react';
import type { PortalNode, Status } from '../../lib/discover';
import { uiPorts, type UiLink } from '../../lib/systems';
import { ServiceIcon } from '../../lib/icons';
import { ICON, Icon } from '../ui/Icon';
import { Card, ToneIcon, type Tone } from './parts';
import type { Gates } from '../../pages/control/home';

interface Internal { key: string; label: string; sub: string; to: string; icon: LucideIcon; needs?: keyof Gates }

// The Settings pages are gated by the same role the card reads: a viewer is not
// offered a link to a page whose only content would be a refusal.
const INTERNAL: Internal[] = [
  { key: 'overview', label: 'Overview', sub: 'the box at a glance', to: '/', icon: LayoutDashboard },
  { key: 'files', label: 'Files', sub: 'docs, notes and config', to: '/files', icon: FolderTree },
  { key: 'updates', label: 'Updates', sub: 'Settings', to: '/settings/updates', icon: PackageCheck, needs: 'updates' },
  { key: 'backups', label: 'Backups', sub: 'Settings', to: '/settings/backups', icon: ArchiveRestore, needs: 'backups' },
  { key: 'audit', label: 'Audit log', sub: 'Settings', to: '/settings/audit', icon: History, needs: 'audit' },
];

const TONE: Record<Status, Tone> = { up: 'ok', starting: 'warn', down: 'bad', stopped: 'off', unknown: 'unknown' };
const WORD: Record<Status, string> = { up: 'Up', starting: 'Starting', down: 'Down', stopped: 'Stopped', unknown: 'Not verified' };

export function QuickLinks({ nodes, gates }: { nodes: PortalNode[]; gates: Gates }) {
  const { stack, project } = uiPorts(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const internal = INTERNAL.filter((i) => !i.needs || gates[i.needs]);
  const count = internal.length + stack.length + project.length;

  const external = (l: UiLink) => {
    const node = byId.get(l.id);
    return (
      <li key={l.id}>
        <a className="ch-ql" href={l.url} target="_blank" rel="noopener noreferrer" data-status={l.status}>
          {node ? <ServiceIcon node={node} size={ICON.md} className="ch-ql-ico" /> : <Icon icon={Link2} className="ch-ql-ico" />}
          <span className="ch-ql-text">
            <span className="ch-ql-name">{l.name}</span>
            <span className="ch-ql-sub">{l.port ? `:${l.port}` : l.host ?? l.group}</span>
          </span>
          {l.status !== 'up' && <ToneIcon tone={TONE[l.status]} label={WORD[l.status]} />}
          <Icon icon={ExternalLink} size="xs" className="ch-ql-ext" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </li>
    );
  };

  return (
    <Card id="ch-ql" title="Quick links" icon={Link2} meta={count} className="ch-links">
      <div className="ch-ql-groups">
        <div className="ch-ql-group">
          <h3 className="eyebrow ch-ql-h">Bothy</h3>
          <ul className="ch-ql-grid">
            {internal.map((i) => (
              <li key={i.key}>
                <Link className="ch-ql" to={i.to}>
                  <Icon icon={i.icon} className="ch-ql-ico" />
                  <span className="ch-ql-text">
                    <span className="ch-ql-name">{i.label}</span>
                    <span className="ch-ql-sub">{i.sub}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        {stack.length > 0 && (
          <div className="ch-ql-group">
            <h3 className="eyebrow ch-ql-h">Stack</h3>
            <ul className="ch-ql-grid">{stack.map(external)}</ul>
          </div>
        )}
        {project.length > 0 && (
          <div className="ch-ql-group">
            <h3 className="eyebrow ch-ql-h">Projects</h3>
            <ul className="ch-ql-grid">{project.map(external)}</ul>
          </div>
        )}
        {stack.length + project.length === 0 && (
          <p className="ch-empty">No published UI was discovered. When a service publishes a port it appears here on its own.</p>
        )}
      </div>
    </Card>
  );
}
