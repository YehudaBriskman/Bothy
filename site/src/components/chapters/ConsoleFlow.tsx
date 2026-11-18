import { ConsoleFrame } from '../../console/ConsoleFrame.tsx';
import type { PageContext } from '../../page-context.ts';

/**
 * The console, played by the scroll. It follows the hero directly: the first thing a visitor sees below the fold is
 * the top of this window, and scrolling lifts it into place and plays the demo (src/story/console.ts reads the
 * beats in src/console/flow.ts). Not a chapter of the descent: the sky holds still under it and the dots skip it.
 * Without script or with reduced motion it is the same frame, at rest, with its tabs and the steps as a list.
 */
export function ConsoleFlow({ ctx }: { ctx: PageContext }) {
  const f = ctx.t.home.flow;
  return (
    <>
      <section id="console" className="ch ch-flow" aria-label={f.label} data-flow>
        <div className="ch-wrap ch-flow-wrap">
          <p className="ch-flow-skip">
            <a href="#descent">{f.skip}</a>
          </p>
          <div className="ch-track" data-console-track>
            <div className="ch-stage">
              <ConsoleFrame />
            </div>
          </div>
        </div>
      </section>
      {/* the end of the story: the sky fades into the page's black through a long soft gradient (story.css). The
        sections after the story follow this marker and sit on --after-story-bg. */}
      <div id="story-end" className="story-end" aria-hidden="true">
        <div className="dither-to-black" />
      </div>
    </>
  );
}
