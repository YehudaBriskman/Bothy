// The global quick view — the BOX, in five numbers.
//
// Scope is deliberately hardware only. A "services" tile lived here briefly and
// restated, one row above it, exactly what the status line says in words — so
// the split is now: this strip is the machine, the status line beneath it is
// what is running on the machine. Neither repeats the other.
//
// This is the redesign of the stat row that used to sit inside the hero, not a
// revival of it. The old one had five cells and every one of them was either
// redundant (`Healthy %` restated the fraction beside it; `Systems` restated
// the matrix below it; `Data` restated the Data & disk panel header) or dead
// (`Trend` was a session ring buffer that read "collecting…" on every load).
// Deleting it outright was an over-correction: the *questions* were right and
// only the answers were bad. "Is the disk filling up" and "is the box busy" are
// exactly what a glance is for, and neither had an answer above the fold.
//
// What changed:
//   · every tile is backed by a real metric with real history, not by a number
//     already printed elsewhere on the page;
//   · CAPACITY metrics get a meter and RATE metrics get a sparkline. Memory and
//     disk are capacities — the question is "how close to full", which a meter
//     answers and a line does not. CPU, network and load are rates — nothing is
//     filling up, and the question is "what has it been doing", which a line
//     answers and a meter does not. (CPU is bounded 0–100 and still gets a line,
//     so "bounded" is the wrong test; a bar under a tile that already prints
//     "25%" would re-encode the number it sits beneath and add nothing.)
//   · disk means the HOST FILESYSTEM — "is the box about to run out" — which is
//     a question 2.9 GB of docker volumes cannot answer.
//
// It owns "now". The charts below own history, and their headers no longer
// repeat the current value, so each fact appears once.

import { useMemo, type ReactNode } from 'react';
import { Cpu, HardDrive, MemoryStick, Network, Timer } from 'lucide-react';
import {
  Q_CPU, Q_MEM, Q_DISK_PCT, Q_DISK_FREE, Q_NET_RX, Q_NET_TX, Q_LOAD, Q_UPTIME,
  fmtPercent, fmtRate, fmtSize, fmtUptimeShort, useMetrics, type Series,
} from '../lib/metrics';
import './QuickView.css';

const lastOf = (s?: Series) => (s && s.points.length ? s.points[s.points.length - 1].v : null);

// Thresholds at which a resource stops being information and becomes a state.
// Using the reserved status palette here is deliberate and consistent with the
// rule: a disk at 92% IS a status, not decoration.
function toneOf(pct: number | null): 'ok' | 'warn' | 'down' {
  if (pct == null) return 'ok';
  if (pct >= 90) return 'down';
  if (pct >= 75) return 'warn';
  return 'ok';
}

export function QuickView() {
  // A fixed 1-hour window, deliberately independent of the charts' range
  // selector: this strip answers "right now, with a little context", and a tile
  // whose sparkline silently changed meaning when you touched a control
  // somewhere else would be worse than no sparkline.
  const specs = useMemo(
    () => [
      { key: 'cpu', query: Q_CPU, label: 'cpu' },
      { key: 'mem', query: Q_MEM, label: 'mem' },
      { key: 'disk', query: Q_DISK_PCT, label: 'disk' },
      { key: 'free', query: Q_DISK_FREE, label: 'free' },
      { key: 'rx', query: Q_NET_RX, label: 'rx' },
      { key: 'tx', query: Q_NET_TX, label: 'tx' },
      { key: 'load', query: Q_LOAD, label: 'load' },
      { key: 'up', query: Q_UPTIME, label: 'up' },
    ],
    [],
  );
  const { series, state } = useMetrics(specs, '1h', 30_000);
  const by = (k: string) => series.find((s) => s.key === k);

  const cpu = lastOf(by('cpu'));
  const mem = lastOf(by('mem'));
  const disk = lastOf(by('disk'));
  const free = lastOf(by('free'));
  const rx = lastOf(by('rx'));
  const tx = lastOf(by('tx'));
  const load = lastOf(by('load'));
  const uptime = lastOf(by('up'));

  const off = state === 'off';

  return (
    <section className="qv" aria-label="At a glance">
      <Tile Icon={Cpu} label="CPU" value={cpu == null ? '—' : fmtPercent(cpu)} off={off}>
        <Spark series={by('cpu')} tone={toneOf(cpu)} />
      </Tile>

      <Tile Icon={MemoryStick} label="Memory" value={mem == null ? '—' : fmtPercent(mem)} off={off}>
        <Meter pct={mem ?? 0} tone={toneOf(mem)} />
      </Tile>

      <Tile
        Icon={HardDrive}
        label="Disk"
        value={disk == null ? '—' : fmtPercent(disk)}
        sub={free == null ? undefined : `${fmtSize(free)} free`}
        off={off}
      >
        <Meter pct={disk ?? 0} tone={toneOf(disk)} />
      </Tile>

      <Tile
        Icon={Network}
        label="Ethernet"
        value={tx == null ? '—' : fmtRate(tx)}
        sub={rx == null ? undefined : `${fmtRate(rx)} in`}
        off={off}
      >
        <Spark series={by('tx')} tone="ok" />
      </Tile>

      <Tile
        Icon={Timer}
        label="Uptime"
        value={uptime == null ? '—' : fmtUptimeShort(uptime)}
        sub={load == null ? undefined : `load ${load.toFixed(2)}`}
        off={off}
      >
        <Spark series={by('load')} tone="ok" />
      </Tile>
    </section>
  );
}

function Tile({
  Icon, label, value, sub, off, children,
}: {
  Icon: typeof Cpu;
  label: string;
  value: string;
  sub?: string;
  off?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="qv-tile">
      <span className="qv-top">
        <Icon size={12} aria-hidden="true" />
        <span className="qv-label">{label}</span>
      </span>
      <span className="qv-value">{value}</span>
      {/* The trajectory row is always present, even when empty, so the tiles
          keep one baseline whether or not a metric is available. */}
      <span className="qv-trend">{off ? <span className="qv-off">no metrics</span> : children}</span>
      {sub && <span className="qv-sub">{sub}</span>}
    </div>
  );
}

/** A bounded value, 0–100. The fill carries severity; the track is the same hue, lighter. */
function Meter({ pct, tone }: { pct: number; tone: 'ok' | 'warn' | 'down' }) {
  return (
    <span className="qv-meter" data-tone={tone} role="img" aria-label={`${Math.round(pct)} percent`}>
      <span className="qv-meter-fill" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </span>
  );
}

/**
 * An unbounded value over the last hour. Twenty-odd points, no axes, no labels.
 *
 * This is NOT the sparkline that was deleted with the old hero. That one plotted
 * a ring buffer held in the tab, so it was empty on every fresh load and could
 * not describe a moment when the tab was closed. This one plots a real range
 * query, which is the thing that makes a sparkline worth its space at all.
 */
function Spark({ series, tone }: { series?: Series; tone: 'ok' | 'warn' | 'down' }) {
  const d = useMemo(() => {
    const pts = series?.points ?? [];
    if (pts.length < 2) return null;
    const w = 100;
    const h = 18;
    const lo = Math.min(...pts.map((p) => p.v));
    const hi = Math.max(...pts.map((p) => p.v));
    const span = hi - lo || 1;
    const step = w / (pts.length - 1);
    // A flat series sits in the middle rather than on the floor, so "steady"
    // does not look like "zero".
    return pts.map((p, i) => `${(i * step).toFixed(1)},${(h - 1 - ((p.v - lo) / span) * (h - 2)).toFixed(1)}`).join(' ');
  }, [series]);

  if (!d) return <span className="qv-spark-empty" />;
  return (
    <svg className="qv-spark" data-tone={tone} viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={d} />
    </svg>
  );
}
