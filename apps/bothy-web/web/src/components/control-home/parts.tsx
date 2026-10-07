// Small shared pieces of the Control landing: the card frame, the tone glyph,
// the three non-answer states, and the sparkline.
//
// Every size here is a token (controlHome.css) and every icon goes through
// ui/Icon, so the batch-4 sweep has nothing to convert in these files.

import { Loader } from '../ui/Loader';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, CircleAlert, CircleCheck, CircleHelp, CirclePause, CircleX, Pin, type LucideIcon,
} from 'lucide-react';
import { Icon } from '../ui/Icon';
import type { Series } from '../../lib/metrics';
import type { SourceState } from './usePolled';

/** A status in words and form, never colour alone. `off` is a state, not a fault. */
export type Tone = 'ok' | 'warn' | 'bad' | 'off' | 'unknown';

const TONE: Record<Tone, { glyph: LucideIcon; word: string }> = {
  ok: { glyph: CircleCheck, word: 'OK' },
  warn: { glyph: CircleAlert, word: 'Needs a look' },
  bad: { glyph: CircleX, word: 'Fault' },
  off: { glyph: CirclePause, word: 'Off' },
  unknown: { glyph: CircleHelp, word: 'Unknown' },
};

export function ToneIcon({ tone, label }: { tone: Tone; label?: string }) {
  return (
    <span className="ch-tone" data-tone={tone}>
      <Icon icon={TONE[tone].glyph} size="sm" />
      <span className="sr-only">{label ?? TONE[tone].word}</span>
    </span>
  );
}

/**
 * The reader's "this is the one I watch" control. Three glance cards of one
 * shape is what makes them comparable and also why none of them is first, so the
 * choice is the reader's and it persists per browser (lib/prefs.ts) - the same
 * idea, and the same storage key, as the Overview's quick-view strip.
 *
 * `on` toggles OFF when it is already the primary, so "none" stays reachable.
 */
export interface Pick { on: boolean; onPick: () => void }

/** A section card: an h2, an optional glance value, and the link onward. */
export function Card({
  id, title, icon, to, toLabel, meta, pick, children, className,
}: {
  id: string;
  title: string;
  icon: LucideIcon;
  /** The detail page this card summarises. */
  to?: string;
  toLabel?: string;
  meta?: ReactNode;
  pick?: Pick;
  children: ReactNode;
  className?: string;
}) {
  return (
    // NOTHING MOVES when a card is chosen, and nothing moves when one of its
    // numbers goes bad: the emphasis is a spine and a raised header, never a
    // different cell or a different span (space-and-layout.md).
    <section
      className={`ch-card${pick?.on ? ' is-primary' : ''}${className ? ` ${className}` : ''}`}
      aria-labelledby={`${id}-h`}
    >
      <header className="ch-card-head">
        <Icon icon={icon} size="sm" className="ch-card-ico" />
        <h2 id={`${id}-h`} className="ch-card-title">{title}</h2>
        {meta != null && <span className="ch-card-meta">{meta}</span>}
        {to && (
          <Link className="ch-card-link" to={to}>
            {toLabel ?? 'Open'}
            <Icon icon={ArrowRight} size="xs" />
          </Link>
        )}
        {/* After the link, not before it: `.ch-card-link` carries the row's one
            `margin-left: auto`, and a second auto margin would split the free
            space between them and strand the pin mid-header. */}
        {pick && (
          <button
            type="button"
            className="ch-pick"
            aria-pressed={pick.on}
            aria-label={pick.on ? `${title} is the card you watch - clear it` : `Watch ${title}: make it the primary card`}
            onClick={pick.onPick}
          >
            <Icon icon={Pin} size="xs" fill={pick.on ? 'currentColor' : 'none'} />
          </button>
        )}
      </header>
      {/* The body is the scroller now that the card is one tile tall, so it
          carries the shared edge cue (lib/scroll.ts drives every .scroll-shade
          from one observer - no per-card wiring). */}
      <div className="ch-card-body scroll-shade">{children}</div>
    </section>
  );
}

/** What a card says instead of its content when its source is not answering. */
export function SourceNote({ state, what, retry }: { state: SourceState; what: string; retry?: ReactNode }) {
  if (state === 'loading') {
    return (
      <div className="ch-loading" aria-busy="true">
        <Loader state="load" size="sm" label={`Loading ${what}…`} />
      </div>
    );
  }
  if (state === 'error') {
    return (
      <p className="ch-unavail">
        <ToneIcon tone="unknown" label="Unavailable" />
        <span>{what[0].toUpperCase() + what.slice(1)} unavailable - the rest of this page is unaffected.</span>
        {retry}
      </p>
    );
  }
  return null;
}

/** One fact in a card: a label and its value, optionally a link. */
export function Fact({ label, children, to }: { label: string; children: ReactNode; to?: string }) {
  return (
    <div className="ch-fact">
      <dt className="ch-fact-k">{label}</dt>
      <dd className="ch-fact-v">{to ? <Link to={to}>{children}</Link> : children}</dd>
    </div>
  );
}

/**
 * A one-series line, no axes. The viewBox is 100 wide and the height is set in
 * CSS; `vector-effect` keeps the stroke its CSS width however it is stretched.
 * `role="img"` with a label that states the range and the last value, because a
 * line alone says nothing to a screen reader.
 */
export function Sparkline({ series, label }: { series: Series | null; label: string }) {
  const pts = series?.points ?? [];
  if (pts.length < 2) return <div className="ch-spark is-empty" role="img" aria-label={`${label}: not enough data yet`} />;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const max = Math.max(...pts.map((p) => p.v), 1e-9);
  const xy = pts.map((p) => `${(((p.t - t0) / Math.max(1, t1 - t0)) * 100).toFixed(2)},${(30 - (p.v / max) * 28 - 1).toFixed(2)}`);
  return (
    <svg className="ch-spark" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={label}>
      <polygon className="ch-spark-area" points={`0,30 ${xy.join(' ')} 100,30`} />
      <polyline className="ch-spark-line" points={xy.join(' ')} />
    </svg>
  );
}
