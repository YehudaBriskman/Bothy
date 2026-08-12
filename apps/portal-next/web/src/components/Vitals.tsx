// Box vitals - the first real graphs this portal has had.
//
// Three charts, one measure each. NOT one chart with three lines: CPU is a
// percentage, memory is a percentage and network is bytes/second, and putting
// two scales on one plot lets whoever drew it choose where the lines cross. Two
// measures of different units get two charts, always.
//
// Everything here degrades to nothing if the metrics route is missing (a box
// where `just portal-prom-route` was never run): the section says so once, in a
// sentence, and the rest of the Overview is untouched. It never blanks a panel
// or throws.

import { useMemo, useState } from 'react';
import { Activity, Cpu, MemoryStick, Network, TriangleAlert } from 'lucide-react';
import {
  RANGES, Q_CPU, Q_MEM, Q_NET_RX, Q_NET_TX,
  fmtPercent, fmtRate, useMetrics, type RangeKey, type Series,
} from '../lib/metrics';
import { TimeChart, ChartLegend, type ChartSeries } from './TimeChart';
import './Vitals.css';

/**
 * peak / average over the visible window.
 *
 * NOT `now` - the quick-view tiles above own the current value, and printing it
 * again here was the same fact in two places at two altitudes, which is the
 * duplication that got the old stat row deleted in the first place. What a chart
 * uniquely knows is the shape of the window: a line tells you the trajectory but
 * not its numbers, so "what was the peak" was otherwise unanswerable without
 * hovering every point.
 *
 * It also equalises the panels: a card with a footer is taller than one without,
 * so either all of them have one or none does.
 */
function summarise(s: Series | undefined): { now: number; peak: number; avg: number } | null {
  if (!s || !s.points.length) return null;
  let peak = -Infinity;
  let sum = 0;
  for (const p of s.points) {
    if (p.v > peak) peak = p.v;
    sum += p.v;
  }
  return { now: s.points[s.points.length - 1].v, peak, avg: sum / s.points.length };
}

export function Vitals() {
  const [range, setRange] = useState<RangeKey>('1h');

  // One poll for all four queries, so the three charts always describe the same
  // instant - separate hooks would drift by up to a refresh interval and the
  // charts would disagree about "now".
  const specs = useMemo(
    () => [
      { key: 'cpu', query: Q_CPU, label: 'CPU' },
      { key: 'mem', query: Q_MEM, label: 'Memory' },
      { key: 'rx', query: Q_NET_RX, label: 'In' },
      { key: 'tx', query: Q_NET_TX, label: 'Out' },
    ],
    [],
  );
  const { series, state, reason } = useMetrics(specs, range);

  const by = (k: string) => series.find((s) => s.key === k);
  const cpu = by('cpu');
  const mem = by('mem');
  const rx = by('rx');
  const tx = by('tx');

  // Slots are assigned here and never change: 1 = CPU, 4 = memory, and the
  // network pair is 1+3 rather than the adjacent 2+3, which measures ΔE 6.3
  // under tritanopia against 31.5 for this pair.
  const cpuS: ChartSeries[] = cpu ? [{ ...cpu, slot: 1 }] : [];
  const memS: ChartSeries[] = mem ? [{ ...mem, slot: 4 }] : [];
  const netS: ChartSeries[] = [
    ...(rx ? [{ ...rx, slot: 1 }] : []),
    ...(tx ? [{ ...tx, slot: 3 }] : []),
  ];

  if (state === 'off') {
    return (
      <section className="vit" aria-label="Box vitals">
        <header className="vit-head">
          <Activity size={14} className="vit-head-ico" aria-hidden="true" />
          <h2 className="vit-title">Box vitals</h2>
        </header>
        <p className="vit-off">
          No metrics route on this box. Run <code>just portal-prom-route</code> in{' '}
          <code>~/stacks</code> to point the portal at Prometheus - nothing else on this
          page depends on it.
        </p>
      </section>
    );
  }

  return (
    <section className="vit" aria-label="Box vitals">
      <header className="vit-head">
        <Activity size={14} className="vit-head-ico" aria-hidden="true" />
        <h2 className="vit-title">Box vitals</h2>

        {state === 'error' && (
          <span className="vit-err" title={reason ?? undefined}>
            <TriangleAlert size={12} aria-hidden="true" /> stale
          </span>
        )}

        {/* The time range. One control for all three charts - a per-chart range
            would let two charts on the same row cover different windows, which
            is the fastest way to make a dashboard lie. */}
        <div className="vit-ranges" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={r.key === range ? 'on' : ''}
              aria-pressed={r.key === range}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      <div className="vit-grid">
        <Panel
          Icon={Cpu}
          title="CPU"
          loading={state === 'loading'}
          footer={<Summary stats={summarise(cpu)} format={fmtPercent} />}
        >
          <TimeChart series={cpuS} format={fmtPercent} yMax={100} area label="Host CPU in use, percent" />
        </Panel>

        <Panel
          Icon={MemoryStick}
          title="Memory"
          loading={state === 'loading'}
          footer={<Summary stats={summarise(mem)} format={fmtPercent} />}
        >
          <TimeChart series={memS} format={fmtPercent} yMax={100} area label="Host memory in use, percent" />
        </Panel>

        <Panel
          Icon={Network}
          title="Ethernet"
          loading={state === 'loading'}
          footer={<ChartLegend series={netS} format={fmtRate} />}
        >
          <TimeChart series={netS} format={fmtRate} label="Ethernet throughput, in and out, bytes per second" />
        </Panel>
      </div>
    </section>
  );
}

function Panel({
  Icon, title, loading, footer, children,
}: {
  Icon: typeof Cpu;
  title: string;
  loading: boolean;
  /** The summary strip. Every panel has one, which is what keeps them equal. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <article className="vit-panel">
      <header className="vit-panel-head">
        <Icon size={13} aria-hidden="true" />
        <h3>{title}</h3>
      </header>
      <div className="vit-panel-body">
        {loading ? <div className="vit-skel" aria-hidden="true" /> : children}
      </div>
      {/* Rendered even while loading, so the panel does not change height when
          the data lands - the shape-matched-skeleton rule applied to a footer. */}
      <footer className="vit-foot">{footer}</footer>
    </article>
  );
}

/** peak · avg, in the same slot the network chart puts its legend. */
function Summary({
  stats, format,
}: {
  stats: { now: number; peak: number; avg: number } | null;
  format: (v: number) => string;
}) {
  if (!stats) return null;
  return (
    <>
      <span className="vit-stat">peak <b>{format(stats.peak)}</b></span>
      <span className="vit-stat">avg <b>{format(stats.avg)}</b></span>
    </>
  );
}
