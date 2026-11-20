import { href } from '../../config.ts';
import { localePrefix } from '../../i18n/locales.ts';
import type { PageContext } from '../../page-context.ts';
import { Lines, ReadWheel } from './Reading.tsx';

/** What Bothy is, true today: three short lines on the flat black ground, rolled past the centre line in big type. */
export function Hut({ ctx }: { ctx: PageContext }) {
  const u = ctx.t.home.hut;
  const p = localePrefix(ctx.locale.code);
  return (
    <ReadWheel id="hut" className="ch-hut" heading={u.heading}>
      <Lines lines={u.lines} />
      <p className="wl wl-link">
        <a className="ch-btn" href={href(`${p}/docs/overview/`)}>
          {u.guide}
        </a>
      </p>
    </ReadWheel>
  );
}
