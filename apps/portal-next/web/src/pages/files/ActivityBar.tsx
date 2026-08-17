// ── the activity bar ─────────────────────────────────────────────────────────
//
// The narrow icon strip on the far left, and the only control that decides WHAT
// THE RAIL IS. Three entries, because this page has three rail-shaped questions:
// which file (Explorer), what is in the files (Search), and what has changed
// (Changes).
//
// IT WAS CALLED "SOURCE CONTROL" until 2026-08-17, which is what VS Code calls
// it, and the rename is not a preference. The top nav now has a section called
// Control, and two unrelated things a click apart cannot share a word that
// carries as much weight as that one - a reader who has just learned that
// "Control" is where the running stack lives should not meet it again meaning
// git. Bothy does not have to borrow VS Code's noun, and "Changes" is what the
// badge on this icon actually counts.
//
// SEARCH WAS DELIBERATELY ABSENT until 2026-08-17, and the reasoning is kept
// rather than deleted because it was correct while it lasted: "the explorer's
// filter is already above the tree, always visible, and searches the same index
// a Search view would - so a third icon would open a panel that duplicates a
// control the user is already looking at."
//
// What changed is the second clause. The filter matches NAMES in a tree the
// browser already holds; the new view reads file CONTENT on the server
// (/-/api/files/search). They no longer search the same index, or answer the
// same question, or cost the same amount - so this is a third view rather than a
// mode of that box, and "no results" now means something unambiguous in each.
//
// It stays mounted when the rail is COLLAPSED, which is the whole reason it is a
// separate column rather than a header inside the rail: with the rail hidden the
// strip is the only thing that can bring it back, and a badge on it is the only
// way "there are eleven changes" reaches someone who works with the rail shut.

import { Files as FilesIcon, GitBranch, Search } from 'lucide-react';

export type RailView = 'explorer' | 'search' | 'scm';

// `hide` is spelled out per view rather than built from the label: "Hide the
// changes" is what a template produces and it is not English.
const VIEWS: { id: RailView; label: string; hide: string; Icon: typeof FilesIcon }[] = [
  { id: 'explorer', label: 'Explorer', hide: 'Hide the explorer', Icon: FilesIcon },
  { id: 'search', label: 'Search', hide: 'Hide search', Icon: Search },
  // The id stays `scm`. It is the localStorage key and the discriminant on
  // RailView; renaming it would reset everyone's open rail to buy nothing a
  // reader ever sees.
  { id: 'scm', label: 'Changes', hide: 'Hide changes', Icon: GitBranch },
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
            {/* Only Changes carries a count, and only when there is one:
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
