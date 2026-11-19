import type { PageContext } from '../../page-context.ts';
import { Lines, ReadWheel } from './Reading.tsx';

/**
 * What a bothy is, on the flat black ground: the lead, the four lines of the Bothy Code and the close, rolled past
 * a centre line in big type (Reading.tsx). No product claim, no panel behind the words, no drawing beside them.
 */
export function Descent({ ctx }: { ctx: PageContext }) {
  const d = ctx.t.home.descent;
  return (
    <ReadWheel id="descent" className="ch-descent" heading={d.heading}>
      <Lines text={d.lead} />
      <p className="wl wl-cap">{d.codeLabel}</p>
      <ul className="wh-code">
        {d.code.map((c) => (
          <li key={c} className="wl">
            {c}
          </li>
        ))}
      </ul>
      <p className="wl wl-note">{d.codeSource}</p>
      <Lines text={d.close} />
    </ReadWheel>
  );
}
