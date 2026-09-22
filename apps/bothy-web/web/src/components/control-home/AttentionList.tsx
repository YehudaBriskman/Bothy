// Needs attention: every actionable finding in one list, most urgent first
// (the order is pages/control/home.ts's, and checks/control-home.mjs holds it).
//
// A service row carries the verbs the Services table already has - the same
// ActionCell and its dialog, so there is one way to restart a thing - and only
// for a session that may act; everyone gets Open. Every other row links to the
// page where its fix lives. Rows are not whole-row links: a row that holds a
// button cannot also be an anchor without nesting interactive content.

import { Link } from 'react-router-dom';
import { AlertTriangle, BellRing } from 'lucide-react';
import type { PortalNode } from '../../lib/discover';
import type { AttentionItem, Severity } from '../../pages/control/home';
import { severityCounts } from '../../pages/control/home';
import { ActionCell } from '../ServiceActions';
import { buttonClass } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Card, ToneIcon, type Tone } from './parts';

const TONE_OF: Record<Severity, Tone> = { critical: 'bad', warning: 'warn', notice: 'unknown' };
const WORD_OF: Record<Severity, string> = { critical: 'Critical', warning: 'Warning', notice: 'Notice' };

export function AttentionList({
  items, nodes, canAct, degraded, pending,
}: {
  items: AttentionItem[];
  nodes: PortalNode[];
  canAct: boolean;
  /** Sources that did not answer - the list covers only what is still visible. */
  degraded: string[];
  /** Sources still loading that could add rows. */
  pending: boolean;
}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const n = severityCounts(items);
  const meta = items.length === 0 ? null : (
    <span className="ch-sev-counts">
      {(['critical', 'warning', 'notice'] as const).filter((s) => n[s] > 0).map((s) => (
        <span key={s} className="ch-sev" data-sev={s}>{n[s]} {WORD_OF[s].toLowerCase()}</span>
      ))}
    </span>
  );

  return (
    <Card id="ch-att" title="Needs attention" icon={BellRing} meta={meta} className="ch-att">
      {degraded.length > 0 && (
        <p className="ch-degraded">
          <Icon icon={AlertTriangle} size="sm" />
          <span>{degraded.join(', ')} did not answer - this list covers only what is still visible.</span>
        </p>
      )}
      {items.length === 0 ? (
        <p className="ch-clear" role="status">
          <ToneIcon tone="ok" label="All clear" />
          <span>
            <strong>All clear.</strong>{' '}
            {pending ? 'Still asking the rest of the sources.' : 'No service is down, every router is enabled, and nothing is waiting on you.'}
          </span>
        </p>
      ) : (
        <div className="ch-scroll scroll-shade" tabIndex={0} role="region" aria-label="Findings">
          <ul className="ch-att-list">
            {items.map((i) => {
              const node = i.nodeId ? byId.get(i.nodeId) : undefined;
              return (
                <li key={i.key} className="ch-att-item" data-sev={i.severity}>
                  <ToneIcon tone={TONE_OF[i.severity]} label={WORD_OF[i.severity]} />
                  <span className="ch-att-text">
                    <span className="ch-att-subject">{i.subject}</span>
                    <span className="ch-att-what">{i.what}</span>
                  </span>
                  <span className="ch-att-acts">
                    {node && canAct && <ActionCell node={node} />}
                    <Link
                      className={buttonClass({ variant: 'ghost', size: 'sm' })}
                      to={i.to}
                      aria-label={`${node ? 'Open' : i.where}: ${i.subject}`}
                    >
                      {node ? 'Open' : i.where}
                    </Link>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}
