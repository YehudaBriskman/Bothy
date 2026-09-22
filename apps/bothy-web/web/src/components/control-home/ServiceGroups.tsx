// Services by group: every system on the box, one collapsible row each, so what
// the landing used to be (down systems, grouped) is still here - and the healthy
// ones too, folded. A system with a fault opens by default; the rest stay closed
// until asked. The head is the same control as the Services page's group head
// (the shared .svc-group-* rules in index.css), so it looks and behaves the same
// in both places, and the body is the same ServiceTable.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, Layers } from 'lucide-react';
import type { PortalNode } from '../../lib/discover';
import { systemsOf, systemHasIssues } from '../../lib/systems';
import { systemLink } from '../../lib/links';
import { ServiceTable } from '../ServiceTable';
import { Disclosure } from '../ui/Disclosure';
import { Icon } from '../ui/Icon';
import { Card, ToneIcon } from './parts';

export function ServiceGroups({ nodes, attention }: { nodes: PortalNode[]; attention: PortalNode[] }) {
  const systems = systemsOf(nodes);
  // Open by default = something in it is on the Needs-attention list. Not
  // systemHasIssues(): that counts a crashed container inside a system that is
  // otherwise switched off, which lib/data.tsx rules is not news.
  const live = new Set(attention.map((n) => n.group));
  // Only a person's explicit toggles are stored; everything else follows the
  // live default, so a system that breaks while the page is open unfolds.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const hot = (s: (typeof systems)[number]) => s.nodes.some((n) => live.has(n.group));
  const sorted = [...systems].sort((a, b) => Number(hot(b)) - Number(hot(a)));

  return (
    <Card id="ch-groups" title="Services by group" icon={Layers} to="/control/services" toLabel="Services" meta={systems.length}>
      {sorted.length === 0 ? (
        <p className="ch-empty">No services were discovered.</p>
      ) : (
        <div className="svc-groups ch-groups">
          {sorted.map((s) => {
            const issues = systemHasIssues(s);
            const open = toggled[s.key] ?? hot(s);
            const bodyId = `ch-group-${s.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
            const tone = s.isOff ? 'off' : s.down > 0 ? 'bad' : s.unknown > 0 ? 'unknown' : 'ok';
            const sub = s.isOff
              ? 'switched off'
              : [`${s.up} / ${s.total - s.stopped} up`, s.down ? `${s.down} down` : '', s.unknown ? `${s.unknown} unverified` : '']
                .filter(Boolean).join(' · ');
            return (
              <section key={s.key} className="svc-group ch-group" aria-label={s.title}>
                <div className="svc-group-head-row">
                  <button
                    className="svc-group-head ch-group-head"
                    onClick={() => setToggled((t) => ({ ...t, [s.key]: !open }))}
                    aria-expanded={open}
                    aria-controls={bodyId}
                  >
                    <Icon icon={ChevronDown} className={`chev ${open ? '' : 'closed'}`} />
                    <ToneIcon tone={tone} label={s.isOff ? 'Off' : issues ? 'Has issues' : 'Healthy'} />
                    <span className="ch-group-title">{s.title}</span>
                    <span className="ch-group-sub">{sub}</span>
                    <span className="tail" />
                    <span className="cnt">{s.total}</span>
                  </button>
                  <Link className="svc-group-open" to={systemLink(s.key)} aria-label={`Open the ${s.title} system page`} title={`Open the ${s.title} system page`}>
                    <Icon icon={ArrowRight} size="sm" />
                  </Link>
                </div>
                <Disclosure open={open} id={bodyId} className="svc-group-body">
                  <ServiceTable nodes={s.nodes} compact showGroup={false} label={`${s.title} services`} />
                </Disclosure>
              </section>
            );
          })}
        </div>
      )}
    </Card>
  );
}
