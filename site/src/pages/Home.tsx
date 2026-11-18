import { Layout } from '../components/Layout.tsx';
import { Descent } from '../components/chapters/Descent.tsx';
import { Hut } from '../components/chapters/Hut.tsx';
import { Inside } from '../components/chapters/Inside.tsx';
import { InstallChapter } from '../components/chapters/InstallChapter.tsx';
import { Sizes } from '../components/chapters/Sizes.tsx';
import { Sky } from '../components/chapters/Sky.tsx';
import { Trust } from '../components/chapters/Trust.tsx';
import type { PageContext } from '../page-context.ts';

export { installLines } from '../components/chapters/InstallChapter.tsx';

/**
 * The story, in seven sections, each a real landmark with a heading, so the page
 * is complete and linkable with no script and no WebGL: the sky, the descent,
 * the hut, what is inside, four sizes, install, trust. Words are in i18n/en.ts;
 * what is proven and what is planned is in facts.ts.
 */
export function Home({ ctx }: { ctx: PageContext }) {
  return (
    <Layout ctx={ctx} nav="home">
      <div className="story">
        <Sky ctx={ctx} />
        <Descent ctx={ctx} />
        <Hut ctx={ctx} />
        <Inside ctx={ctx} />
        <Sizes ctx={ctx} />
        <InstallChapter ctx={ctx} />
        <Trust ctx={ctx} />
      </div>
    </Layout>
  );
}
