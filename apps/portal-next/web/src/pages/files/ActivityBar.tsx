// ── the activity bar ─────────────────────────────────────────────────────────
//
// The narrow icon strip on the far left, and the only control that decides WHAT
// THE RAIL IS. Two entries, because this page has two rail-shaped questions:
// which file (Explorer) and what has changed (Source Control).
//
// There is deliberately NO Search icon. The explorer's filter is already above
// the tree, always visible, and searches the same index a Search view would - so
// a third icon would open a panel that duplicates a control the user is already
// looking at. An icon that leads somewhere pointless is worse than no icon.
//
// It stays mounted when the rail is COLLAPSED, which is the whole reason it is a
// separate column rather than a header inside the rail: with the rail hidden the
// strip is the only thing that can bring it back, and a badge on it is the only
// way "there are eleven changes" reaches someone who works with the rail shut.

import { Files as FilesIcon, GitBranch } from 'lucide-react';

export type RailView = 'explorer' | 'scm';

// `hide` is spelled out per view rather than built from the label: "Hide the
// source control" is what a template produces and it is not English.
const VIEWS: { id: RailView; label: string; hide: string; Icon: typeof FilesIcon }[] = [
  { id: 'explorer', label: 'Explorer', hide: 'Hide the explorer', Icon: FilesIcon },
  { id: 'scm', label: 'Source Control', hide: 'Hide Source Control', Icon: GitBranch },
];

export function ActivityBar({ view, onPick, changes, collapsed }: {
  view: RailView;
  /** Called with the view that was clicked; the caller decides whether that
   *  means "switch", "open the rail" or "collapse it" - see Files.tsx. */
  onPick: (v: RailView) => void;
  /** Changed files in the repo currently in scope, or 0. */
  changes: number;
  collapsed: boolean;
}) {
  return (
    <nav className="fx-act" aria-label="Views">
      {VIEWS.map(({ id, label, hide, Icon }) => {
        // "Selected" and "visible" are different facts and the rail can be shut
        // while a view is selected. The tooltip says which, because a lit icon
        // over an invisible rail is otherwise just confusing.
        const on = view === id;
        const hint = on && !collapsed ? hide : label;
        return (
          // A plain `title`, not the shared Tooltip. That component draws its
          // bubble inside its own wrapper (components/Tooltip.tsx says so: no
          // portal, no collision logic), and this strip is 46px wide with
          // `overflow: hidden` on the column - the bubble would be clipped to a
          // sliver. The accessible name is on the button either way, so what is
          // lost is the styling, not the information.
          <button
            key={id}
            type="button"
            className={`fx-actbtn ${on && !collapsed ? 'on' : ''} ${on && collapsed ? 'sel' : ''}`}
            aria-pressed={on && !collapsed}
            aria-label={hint}
            title={hint}
            onClick={() => onPick(id)}
          >
            <Icon size={19} aria-hidden="true" />
            {/* Only Source Control carries a count, and only when there is one:
                a badge reading 0 is a badge that has stopped meaning anything.
                Capped at 99 so a repo mid-rebase cannot widen the strip. */}
            {id === 'scm' && changes > 0 && (
              <span className="fx-actbadge tnum" aria-hidden="true">
                {changes > 99 ? '99+' : changes}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
