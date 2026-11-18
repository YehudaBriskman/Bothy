import type { PageContext } from '../../page-context.ts';

/**
 * The page-wide sky: one fixed, full-viewport backdrop behind every chapter. `.sky-still` is the photograph for the
 * hour (CSS only, no script needed) and the live canvas is drawn into it; the three `.sky-scene` layers are the
 * chapter backdrops (a lit cumulus, a cloud deck, twilight bands), cross-faded by scroll and loaded only when their
 * chapter is near. All decorative, so all hidden from assistive technology. To swap a different scene in later, change
 * `SCENES` in src/story/scenes.ts; nothing here knows which photograph a scene is.
 */
export function SkyStage({ scenes }: { scenes: readonly string[] }) {
  return (
    <div className="sky-stage" aria-hidden="true">
      <div className="sky-still" data-sky-layer />
      {scenes.map((id) => (
        <div key={id} className="sky-scene" data-scene={id} />
      ))}
    </div>
  );
}

/** The progress dots. Rendered hidden: they are links to the chapters, shown once the story script runs. */
export function ChapterDots({ ctx, ids }: { ctx: PageContext; ids: readonly string[] }) {
  const names = ctx.t.home.chapterNames;
  return (
    <nav className="story-dots" data-story-dots hidden aria-label={ctx.t.home.chapterNav}>
      <ol>
        {ids.map((id, i) => (
          <li key={id}>
            <a href={`#${id}`} data-ch-link={id}>
              <span className="visually-hidden">{names[i]}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
