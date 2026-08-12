// The system quick-lookup.
//
// Clicking a chip in the matrix used to navigate to /systems/:key — a full page
// load's worth of context switch to answer "what's actually in this thing, and
// is it busy". That is a LOOKUP, not a destination: you want it, you read it,
// you carry on scanning. So the chip now opens this dialog, and the dialog links
// on to the full page for the cases where you did want to leave.
//
// It adds the one thing neither the chip nor the system page could show: live
// per-container CPU and memory, in one Prometheus query scoped to this system's
// containers. Not one query per container — a system with eight services would
// be eight round trips on every open.

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Cpu, ExternalLink, HardDrive, MemoryStick, Workflow } from 'lucide-react';
import { conditionLabel, resolveEdges, sharedNamespace } from '../lib/discover';
import type { System } from '../lib/systems';
import { fmtBytes, fmtUptime } from '../lib/systems';
import { serviceLink, systemLink } from '../lib/links';
import { ServiceIcon, StatusIcon } from '../lib/icons';
import { promQuote, fmtCores, useMetrics } from '../lib/metrics';
import { BarGauge, type GaugeRow } from './viz';
import { Dialog } from './ui/Dialog';
import './SystemDialog.css';

export function SystemDialog({
  system, open, onOpenChange,
}: {
  system: System | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  // Every container this system owns, as one alternation for a `=~` matcher.
  // Names are regex-quoted as well as string-quoted: a container called `a.b`
  // would otherwise match `axb` — harmless here, but it is one character of
  // care against a whole class of wrong-row bugs.
  const names = useMemo(
    () =>
      (system?.nodes ?? [])
        .map((n) => n.container?.name)
        .filter((n): n is string => !!n),
    [system],
  );
  const matcher = names.map((n) => promQuote(n).replace(/[.+*?()|[\]{}^$\\]/g, '\\$&')).join('|');

  // Prefer the namespace label over an alternation of container names.
  //
  // cAdvisor exports container_label_com_docker_compose_project on every series
  // — it has been there the whole time and nothing queried it. It is the same
  // key semconv calls service.namespace, and it beats the name list on every
  // axis: one label instead of an N-term regex that grows with the system and
  // needs escaping; correct when a container is renamed or replaced; and it
  // still finds containers this page has not discovered, which is exactly the
  // blind spot a control plane must not have.
  //
  // Falls back to names when the group has no single compose project — the
  // `unmanaged` bag of `docker run` orphans, and any group holding declared host
  // processes. A namespace query there would silently return a DIFFERENT set
  // than the rows above it, which is worse than the clumsier query.
  const ns = useMemo(() => sharedNamespace(system?.nodes ?? []), [system]);

  const specs = useMemo(() => {
    const sel = ns
      ? `container_label_com_docker_compose_project="${promQuote(ns)}"`
      : matcher
        ? `name=~"${matcher}"`
        : null;
    if (!sel) return [];
    return [
      {
        key: 'cpu',
        query: `sum by (name) (rate(container_cpu_usage_seconds_total{${sel}}[2m]))`,
        labelKeys: ['name'],
      },
      {
        key: 'mem',
        query: `sum by (name) (container_memory_working_set_bytes{${sel}})`,
        labelKeys: ['name'],
      },
    ];
  }, [ns, matcher]);
  // 15m at a coarse step: this only ever reads the LAST point, so a long window
  // would be bytes on the wire for samples nothing renders.
  const { series, state } = useMetrics(specs, '15m', 60_000);

  const rows = useMemo(() => {
    const lastOf = (prefix: string) => {
      const out = new Map<string, number>();
      for (const s of series) {
        if (!s.key.startsWith(`${prefix}:`) || !s.points.length) continue;
        out.set(s.label, s.points[s.points.length - 1].v);
      }
      return out;
    };
    return { cpu: lastOf('cpu'), mem: lastOf('mem') };
  }, [series]);

  // The wiring, declared by whoever wrote the compose file. Resolved against
  // this system's own nodes, so a dependency on something outside it renders as
  // broken — which is the honest answer: from in here, it IS missing.
  const edges = useMemo(() => resolveEdges(system?.nodes ?? []), [system]);

  if (!system) return null;

  const cpuRows: GaugeRow[] = [...rows.cpu.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, v]) => ({ key: name, label: name, value: v, display: fmtCores(v), accent: system.accent }));
  const memRows: GaugeRow[] = [...rows.mem.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, v]) => ({ key: name, label: name, value: v, display: fmtBytes(v), accent: system.accent }));

  const counts = [
    system.up && `${system.up} up`,
    system.starting && `${system.starting} starting`,
    system.down && `${system.down} down`,
    system.unknown && `${system.unknown} unknown`,
    system.stopped && `${system.stopped} stopped`,
  ].filter(Boolean).join(' · ');

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <>
          <span className="sd-acc" style={{ background: `var(${system.accent})` }} aria-hidden="true" />
          {system.title}
          <span className="sd-kind">{system.kind}</span>
        </>
      }
      description={counts || 'Nothing discovered in this system.'}
      footer={
        <Link className="btn" to={systemLink(system.key)} onClick={() => onOpenChange(false)}>
          Open system page <ArrowRight size={14} />
        </Link>
      }
    >
      <h4 className="sd-h">Services <span className="sd-n">{system.nodes.length}</span></h4>
      <ul className="sd-list">
        {system.nodes.map((n) => (
          <li className="sd-row" key={n.id}>
            <span className="ico sm"><ServiceIcon node={n} size={14} /></span>
            <Link className="sd-row-name" to={serviceLink(n)} onClick={() => onOpenChange(false)}>
              {n.name}
            </Link>
            {/* A one-shot that exited 0 did its job. `stopped` is technically
                true and operationally misleading — it reads as "somebody
                switched this off", which invites someone to start it. The
                status icon still carries the real state for colour and
                counting; only the WORD changes, and only where the compose
                file declared the intent. */}
            {n.completesOnPurpose && n.status === 'stopped' ? (
              <span className="sd-done" title="Ran to completion — a dependent waits on service_completed_successfully">
                <CheckCircle2 size={13} aria-hidden="true" /> completed
              </span>
            ) : (
              <StatusIcon status={n.status} />
            )}
            <span className="sd-row-meta">
              {n.host ?? (n.ports[0] ? `:${n.ports[0].hostPort}` : '—')}
            </span>
            {n.uptimeSecs != null && <span className="sd-row-up">{fmtUptime(n.uptimeSecs)}</span>}
            {n.url && (
              <a
                className="sd-row-open"
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${n.name} in a new tab`}
              >
                <ExternalLink size={13} />
              </a>
            )}
          </li>
        ))}
      </ul>

      {/* The startup order, as declared — not inferred from traffic or naming.
          Docker has written this onto every container it created since the
          stack existed and nothing has ever read it back. */}
      {edges.length > 0 && (
        <>
          <h4 className="sd-h">
            <Workflow size={12} aria-hidden="true" /> Wiring <span className="sd-n">{edges.length}</span>
          </h4>
          <ul className="sd-edges">
            {edges.map((e, i) => (
              <li key={`${e.from.id}-${e.toService}-${i}`} className={e.to ? '' : 'broken'}>
                <span className="sd-edge-from">{e.from.name}</span>
                <span className="sd-edge-arrow" aria-hidden="true">waits for</span>
                {e.to ? (
                  <Link to={serviceLink(e.to)} onClick={() => onOpenChange(false)}>{e.to.name}</Link>
                ) : (
                  // Named, not hidden: "the thing it needs isn't here" is the
                  // useful half of the signal, and dropping the edge would
                  // present a system that looks correctly wired.
                  <span className="sd-edge-missing" title="Declared in the compose file, but no such container was discovered">
                    {e.toService} <em>missing</em>
                  </span>
                )}
                <span className="sd-edge-cond">{conditionLabel(e.condition)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Resource use is a magnitude question — "which of these is the big one" —
          so it is bars against the largest, not numbers in a list. Absent
          entirely when there are no metrics, rather than an empty chart. */}
      {cpuRows.length > 0 && (
        <>
          <h4 className="sd-h"><Cpu size={12} aria-hidden="true" /> CPU now</h4>
          <BarGauge rows={cpuRows} />
        </>
      )}
      {memRows.length > 0 && (
        <>
          <h4 className="sd-h"><MemoryStick size={12} aria-hidden="true" /> Memory now</h4>
          <BarGauge rows={memRows} />
        </>
      )}
      {state === 'off' && names.length > 0 && (
        <p className="sd-note">Live CPU and memory need the metrics route — <code>just portal-prom-route</code>.</p>
      )}

      {system.volumes.length > 0 && (
        <>
          <h4 className="sd-h"><HardDrive size={12} aria-hidden="true" /> Volumes <span className="sd-n">{system.volumes.length}</span></h4>
          <ul className="sd-vols">
            {system.volumes.map((v) => (
              <li key={v.name}>
                <span className="mono">{v.name}</span>
                {v.destination && <span className="sd-vol-dest">{v.destination}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
