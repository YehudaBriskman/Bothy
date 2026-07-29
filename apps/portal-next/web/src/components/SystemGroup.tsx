import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import type { System } from '../lib/systems';
import { systemHasIssues } from '../lib/systems';
import { systemLink } from '../lib/links';
import { StatusBar, type Seg } from './viz';
import './SystemGroup.css';

// One card per KIND, not per system.
//
// The Overview used to render one card per discovered system — 14 of them, of
// which 8 said "1 / 1 running · 100% healthy" and carried no other information.
// That is the "shows everything, communicates the priority of nothing" failure:
// the shared stack is one thing you either trust or don't, so it gets one card
// with a rollup, and expands only when you ask.
//
// Projects stay individually visible (they are what the box is FOR and there
// are few of them); stack + infra collapse by default.

export interface GroupSpec {
  key: string;
  title: string;
  hint: string;
  systems: System[];
}

function rollup(systems: System[]) {
  let up = 0, down = 0, starting = 0, unknown = 0, total = 0;
  for (const s of systems) {
    up += s.up; down += s.down; starting += s.starting; unknown += s.unknown; total += s.total;
  }
  return { up, down, starting, unknown, total };
}

export function SystemGroup({
  group,
  open,
  onToggle,
}: {
  group: GroupSpec;
  open: boolean;
  onToggle: () => void;
}) {
  const r = rollup(group.systems);
  const bad = group.systems.filter(systemHasIssues);
  const segs: Seg[] = [
    { key: 'up', n: r.up, label: 'up' },
    { key: 'starting', n: r.starting, label: 'starting' },
    { key: 'down', n: r.down, label: 'down' },
    { key: 'unknown', n: r.unknown, label: 'unknown' },
  ];

  return (
    <section className={`sg ${open ? 'is-open' : ''} ${bad.length ? 'has-issues' : ''}`}>
      <button className="sg-head" onClick={onToggle} aria-expanded={open}>
        <ChevronDown size={15} className="sg-chev" aria-hidden="true" />
        <span className="sg-title">{group.title}</span>
        <span className="sg-count">{group.systems.length}</span>

        <span className="sg-nums">
          <b className="tnum">{r.up}</b>
          <span className="sg-of">/ {r.total} up</span>
        </span>

        <span className="sg-bar"><StatusBar segs={segs} height={7} /></span>

        {/* the one thing worth saying out loud when it isn't all green */}
        {bad.length > 0 ? (
          <span className="sg-flag">{bad.length} need{bad.length === 1 ? 's' : ''} a look</span>
        ) : (
          <span className="sg-ok">all clear</span>
        )}
      </button>

      {open && (
        <ul className="sg-list">
          {group.systems.map((s) => {
            const issues = systemHasIssues(s);
            return (
              <li key={s.key}>
                <Link
                  to={systemLink(s.key)}
                  className={`sg-row ${issues ? 'is-bad' : ''}`}
                  style={{ ['--acc' as string]: `var(${s.accent})` } as React.CSSProperties}
                >
                  <span className="sg-row-name">{s.title}</span>
                  <span className="sg-row-bar">
                    <StatusBar
                      segs={[
                        { key: 'up', n: s.up, label: 'up' },
                        { key: 'starting', n: s.starting, label: 'starting' },
                        { key: 'down', n: s.down, label: 'down' },
                        { key: 'unknown', n: s.unknown, label: 'unknown' },
                      ]}
                      height={5}
                    />
                  </span>
                  <span className="sg-row-n">{s.up}/{s.total}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
