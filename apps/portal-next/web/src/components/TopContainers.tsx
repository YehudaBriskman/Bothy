// "What is actually using this box" — the busiest containers, right now.
//
// A bar gauge, not a line chart: the question is a MAGNITUDE comparison across
// a handful of named things at one instant ("which of these is the big one"),
// and bars against the largest answer that in one glance. Five overlapping time
// series answer it slowly and badly.
//
// It reuses the BarGauge that the Data & disk panel already uses, so a reader
// who has learned to read one has learned to read the other.

import { useMemo, useState } from 'react';
import { Flame } from 'lucide-react';
import { qAllContainerCpu, qAllContainerMem, fmtCores, useMetrics } from '../lib/metrics';
import { fmtBytes } from '../lib/systems';
import { usePortal } from '../lib/data';
import { BarGauge, type GaugeRow } from './viz';
import { Tabs } from './Tabs';

const TOP_N = 6;

export function TopContainers() {
  const [tab, setTab] = useState<'cpu' | 'mem'>('cpu');
  // "top 6 of 23" needs the denominator, and the poll already knows it — no
  // second query for a number we are holding.
  const { data } = usePortal();
  const running = useMemo(
    () => data.nodes.filter((n) => n.container && (n.status === 'up' || n.status === 'starting')).length,
    [data.nodes],
  );

  // Both queries always run: switching tabs is then instant and never shows a
  // spinner for data that was one round trip away. Two series of 6 points each
  // is nothing on the wire.
  const specs = useMemo(
    () => [
      { key: 'cpu', query: qAllContainerCpu, labelKeys: ['name'] },
      { key: 'mem', query: qAllContainerMem, labelKeys: ['name'] },
    ],
    [],
  );
  const { series, state } = useMetrics(specs, '15m', 30_000);

  // The LAST value of every series, per metric, keyed by container name. Built
  // for both metrics regardless of the active tab, because each row shows the
  // metric it is ranked by AND the other one beside it — a bar with a single
  // number tells you the order but nothing about what the thing actually is.
  const latest = useMemo(() => {
    const pick = (prefix: string) => {
      const out = new Map<string, number>();
      for (const s of series) {
        if (!s.key.startsWith(`${prefix}:`) || !s.points.length) continue;
        out.set(s.label, s.points[s.points.length - 1].v);
      }
      return out;
    };
    return { cpu: pick('cpu'), mem: pick('mem') };
  }, [series]);

  const rows = useMemo<GaugeRow[]>(() => {
    const primary = tab === 'cpu' ? latest.cpu : latest.mem;
    const other = tab === 'cpu' ? latest.mem : latest.cpu;
    return [...primary.entries()]
      .map(([name, v]) => {
        const paired = other.get(name);
        return {
          key: name,
          label: name,
          value: v,
          display: tab === 'cpu' ? fmtCores(v) : fmtBytes(v),
          // The companion metric, in the slot the disk panel uses for "3 vols".
          sub: paired == null ? '' : tab === 'cpu' ? fmtBytes(paired) : fmtCores(paired),
        };
      })
      .sort((a, b) => b.value - a.value)
      // Ranked here rather than by `topk` in the query — see lib/metrics.ts for
      // why. Slicing after sorting on the latest value is what makes the
      // "top N" in the footer literally true.
      .slice(0, TOP_N);
  }, [latest, tab]);

  // The summary strip: what is in the panel above it, the way a chart legend
  // says what is in the chart.
  const totals = useMemo(() => {
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    return { cpu: sum(latest.cpu), mem: sum(latest.mem), n: latest.cpu.size || latest.mem.size };
  }, [latest]);

  return (
    <section className="ov-panel">
      <header className="ov-panel-head">
        <Flame size={14} className="ov-panel-ico" aria-hidden="true" />
        <h2 className="ov-panel-title">Busiest containers</h2>
      </header>
      <div className="ov-panel-body scroll-shade">
        <Tabs
          tabs={[{ key: 'cpu', label: 'CPU' }, { key: 'mem', label: 'Memory' }]}
          value={tab}
          onChange={(k) => setTab(k as 'cpu' | 'mem')}
          label="Rank containers by"
        />
        {state === 'off' ? (
          <p className="ov-uicol-empty">Needs the metrics route — <code>just portal-prom-route</code>.</p>
        ) : rows.length ? (
          <BarGauge rows={rows} />
        ) : (
          <p className="ov-uicol-empty">
            {state === 'loading' ? 'Reading metrics…' : 'No container metrics in this window.'}
          </p>
        )}
      </div>

      {rows.length > 0 && (
        <footer className="ov-panel-foot">
          <span>top <b>{rows.length}</b> of <b>{running}</b> running</span>
          <span className="sep">·</span>
          <span>cpu <b>{fmtCores(totals.cpu)}</b></span>
          <span className="sep">·</span>
          {/* No "bar = CPU" legend: every value on the row carries its own unit
              (`0.12 cores` beside `763 MB`), so a key would be a second line of
              footer saying what the first line already says. */}
          <span>mem <b>{fmtBytes(totals.mem)}</b></span>
        </footer>
      )}
    </section>
  );
}
