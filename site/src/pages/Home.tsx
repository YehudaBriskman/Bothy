import { AfterStory } from '../components/AfterStory.tsx';
import { NewSections } from '../components/new-sections/NewSections.tsx';
import { Layout } from '../components/Layout.tsx';
import { ConsoleFlow } from '../components/chapters/ConsoleFlow.tsx';
import { Descent } from '../components/chapters/Descent.tsx';
import { Hut } from '../components/chapters/Hut.tsx';
import { Inside } from '../components/chapters/Inside.tsx';
import { InstallChapter } from '../components/chapters/InstallChapter.tsx';
import { Sizes } from '../components/chapters/Sizes.tsx';
import { Sky } from '../components/chapters/Sky.tsx';
import { ChapterDots, SkyStage } from '../components/chapters/SkyStage.tsx';
import { Trust } from '../components/chapters/Trust.tsx';
import type { PageContext } from '../page-context.ts';
import { SCENES } from '../story/scenes.ts';

export { installLines } from '../components/chapters/InstallChapter.tsx';

/** The chapter ids, in order: the dots, the progress map and the skip links all read this one list. */
export const CHAPTERS = ['sky', 'descent', 'hut', 'inside', 'sizes', 'install', 'trust'] as const;

/**
 * The story, in seven sections over one fixed sky. Each section is a real landmark with a heading, so the page is
 * complete and linkable with no script and no WebGL: the sky, the descent, the hut, what is inside, four sizes,
 * install, trust. Words are in i18n/en.ts; what is proven and what is planned is in facts.ts.
 */
export function Home({ ctx }: { ctx: PageContext }) {
  return (
    <Layout ctx={ctx} nav="home" cta glow={false}>
      <div className="story" data-story>
        <SkyStage scenes={SCENES.map((s) => s.id)} />
        <Sky ctx={ctx} />
        <ConsoleFlow ctx={ctx} />
        <Descent ctx={ctx} />
        <Hut ctx={ctx} />
        <Inside ctx={ctx} />
        <Sizes ctx={ctx} />
        <InstallChapter ctx={ctx} />
        <Trust ctx={ctx} />
        <ChapterDots ctx={ctx} ids={CHAPTERS} />
      </div>
      <AfterStory ctx={ctx} />
      <NewSections ctx={ctx} />
    </Layout>
  );
}
