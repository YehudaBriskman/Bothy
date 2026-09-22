// The health strip: the most prominent thing on the landing, because "is the box
// all right" is the question it is opened to answer. One tile per source, each a
// link to the page that owns the number - a number you cannot follow is a claim.
//
// A tile whose source the role does not reach is not drawn at all (backups for a
// viewer); a tile whose source failed says "Unavailable" in words and keeps its
// link, so the way to the detail page survives the source being down.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ToneIcon, type Tone } from './parts';

export interface Tile {
  key: string;
  label: string;
  value: ReactNode;
  sub: ReactNode;
  to: string;
  tone: Tone;
  /** The tone in words, for the glyph's accessible name. */
  toneLabel: string;
}

export function HealthStrip({ tiles }: { tiles: Tile[] }) {
  return (
    <section className="ch-health" aria-labelledby="ch-health-h">
      <h2 id="ch-health-h" className="sr-only">Health</h2>
      <ul className="ch-strip">
        {tiles.map((t) => (
          <li key={t.key}>
            <Link className="ch-tile" to={t.to} data-tone={t.tone}>
              <span className="ch-tile-top">
                <span className="eyebrow">{t.label}</span>
                <ToneIcon tone={t.tone} label={t.toneLabel} />
              </span>
              <span className="ch-tile-value">{t.value}</span>
              <span className="ch-tile-sub">{t.sub}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
