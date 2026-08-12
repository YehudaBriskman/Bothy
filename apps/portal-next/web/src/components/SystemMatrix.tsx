import type { System } from '../lib/systems';
import type { Status } from '../lib/discover';
import './SystemMatrix.css';

// Every system, always visible, one cell per service.
//
// This replaces SystemGroup - three collapsible cards whose open/closed state
// was persisted in localStorage under `portal-open-groups`. Two things were
// wrong with that, and the second is the one that matters:
//
//   1. The answer to "is everything ok" required a click, and a persisted
//      open/closed state meant two visits to the same healthy box rendered
//      differently. State that survives a reload should describe the BOX, not
//      the furniture.
//
//   2. Density. An expanded row was a full-width line - measured 1126×31px -
//      carrying a name and one bit: live or not live. ~35,000 px² for one
//      dimension, about 7× worse per dimension than the tables elsewhere in
//      this app. Meanwhile 9 of 13 systems never had anything to say.
//
// The rule this applies, and which the rest of the page is now measured
// against: an element's footprint should be proportional to the number of
// information dimensions it carries. A service's status is one dimension, so it
// gets one cell. A system is a name plus its services' states, so it gets a
// name plus a row of cells. Thirteen systems and twenty-seven services fit in
// roughly the height the old Projects group alone used to take.
//
// Pop-out does the work: one rose cell in a field of green is found in constant
// time regardless of how many cells there are - which is why this scales to a
// box with 60 services, and a list of rows does not.

const ORDER: Status[] = ['down', 'unknown', 'starting', 'up', 'stopped'];
const LABEL: Record<Status, string> = {
  down: 'down', unknown: 'unknown', starting: 'starting', up: 'up', stopped: 'stopped',
};

// ONE definition of "needs a look", shared with the hero.
//
// systemHasIssues() said `down > 0 || unknown > 0`, which does not know what
// needsAttention() knows: an orphan @file route belonging to a system that is
// entirely switched off is not a fault (stopping Tals "orphans" all four of its
// host routes at once). So the hero counted 0 and this counted 3, six pixels
// apart, on the same screen. Deriving the flag from the same node list the hero
// counts makes disagreement impossible rather than merely unlikely - which is
// the point, since the two numbers drifted apart the moment they had separate
// definitions.
const isBad = (s: System, attentionIds: Set<string>) => s.nodes.some((n) => attentionIds.has(n.id));

// Exception-first. A system with something wrong sorts above a healthy one, and
// an entirely-off system sorts last - it is a statement, not a problem.
function bySeverity(attentionIds: Set<string>) {
  const rank = (s: System) => (isBad(s, attentionIds) ? 0 : s.isOff ? 2 : 1);
  return (a: System, b: System) =>
    rank(a) - rank(b) || b.total - a.total || a.title.localeCompare(b.title);
}

// The chip is a BUTTON that opens the quick-lookup dialog, not a link to the
// system page.
//
// It used to navigate. But the matrix exists to be SCANNED - you are running
// your eye along thirteen systems looking for the one with a rose cell - and the
// question a chip raises ("what is in this, is it busy") is a lookup you want
// answered next to the thing you were scanning, not a page you have to come back
// from. The dialog still links on to the full system page, so nothing is lost;
// the difference is that reading it no longer costs your place on the Overview.
function SystemChip({
  system, issues, onOpen,
}: {
  system: System;
  issues: boolean;
  onOpen: (s: System) => void;
}) {
  // Cells in a fixed severity order so two systems can be compared by eye, and
  // so the eye lands on the left edge of a row to find trouble.
  const cells = [...system.nodes]
    .filter((n) => !n.hidden)
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));

  const summary = ORDER
    .map((s) => ({ s, n: cells.filter((c) => c.status === s).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${LABEL[x.s]}`)
    .join(', ');

  return (
    <button
      type="button"
      onClick={() => onOpen(system)}
      className={`sm-chip ${issues ? 'is-bad' : ''} ${system.isOff ? 'is-off' : ''}`}
      style={{ ['--acc' as string]: `var(${system.accent})` } as React.CSSProperties}
      aria-haspopup="dialog"
      aria-label={`${system.title}: ${summary || 'nothing discovered'}`}
    >
      <span className="sm-chip-name">{system.title}</span>
      <span className="sm-cells" aria-hidden="true">
        {cells.map((n) => (
          <span key={n.id} className="sm-cell" data-state={n.status} title={`${n.name} - ${LABEL[n.status]}`} />
        ))}
        {cells.length === 0 && <span className="sm-cell" data-state="unknown" />}
      </span>
      {/* The count is a second dimension the cells alone do not carry: at a
          glance eight cells and nine cells are the same shape, and "how big is
          this system" is a real question when you are choosing where to look. */}
      <span className="sm-chip-n" aria-hidden="true">{cells.length || '-'}</span>
    </button>
  );
}

export interface MatrixGroup {
  key: string;
  title: string;
  systems: System[];
}

export function SystemMatrix({
  groups, attentionIds, onOpen,
}: { groups: MatrixGroup[]; attentionIds: Set<string>; onOpen: (s: System) => void }) {
  return (
    <section className="sm" aria-label="Systems">
      {groups.map((g) => {
        const sorted = [...g.systems].sort(bySeverity(attentionIds));
        const bad = sorted.filter((s) => isBad(s, attentionIds)).length;
        return (
          <div className="sm-group" key={g.key}>
            {/* The heading is a ROW LABEL, not a line of its own.
                Measured before this change: three stacked headings above three
                wrapping rows made six lines of layout for thirteen items, and
                the rows were only 41%, 53% and 28% full - so more than half of
                a 209px block was empty space beside the chips. Moving the label
                into a fixed first column uses that space and halves the height,
                with nothing removed. */}
            <h2 className="sm-group-h">
              <span className="sm-group-t">{g.title}</span>
              <span className="sm-group-n">{g.systems.length}</span>
              {/* Only said when it is true. A per-group "all clear" on every
                  group is three reassurances nobody reads, which is how the real
                  one stops being noticed. */}
              {bad > 0 && <span className="sm-group-bad">{bad} need{bad === 1 ? 's' : ''} a look</span>}
            </h2>
            <div className="sm-row">
              {sorted.map((s) => (
                <SystemChip key={s.key} system={s} issues={isBad(s, attentionIds)} onOpen={onOpen} />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
