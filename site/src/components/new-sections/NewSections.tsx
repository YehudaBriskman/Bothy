import { Compare } from './Compare.tsx';
import { Hood } from './Hood.tsx';
import { Motion } from './Motion.tsx';
import { Parts } from './Parts.tsx';
import type { PageContext } from '../../page-context.ts';

/**
 * The four sections owner-chosen on 2026-11-19 (docs/plans/thin-bothy/new-sections-options.md, 21 to 24), in page
 * order. They sit straight on the page's flat ink: no background behind any group, sky only in photo windows (there
 * is none here). Their stylesheet is styles/new-sections.css; the only script is the lazy new-sections.ts player.
 */
export function NewSections({ ctx }: { ctx: PageContext }) {
  return (
    <div className="more-story" data-nsec>
      <Parts />
      <Motion />
      <Compare ctx={ctx} />
      <Hood />
    </div>
  );
}
