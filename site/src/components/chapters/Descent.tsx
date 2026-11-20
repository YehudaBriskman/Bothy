import type { PageContext } from '../../page-context.ts';
import { Lines, ReadWheel } from './Reading.tsx';

/** What a bothy is, on the flat black ground: three short lines rolled past a centre line in big type (Reading.tsx). */
export function Descent({ ctx }: { ctx: PageContext }) {
  const d = ctx.t.home.descent;
  return (
    <ReadWheel id="descent" className="ch-descent" heading={d.heading}>
      <Lines lines={d.lines} />
    </ReadWheel>
  );
}
