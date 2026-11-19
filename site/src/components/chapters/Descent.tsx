import type { PageContext } from '../../page-context.ts';
import { Lines, ReadSection } from './Reading.tsx';

/**
 * A bothy drawn in plain SVG. Each part carries `data-from`: it lights once that many lines of the text beside it
 * have been read (home-sections.ts). Decorative only: the words say everything the drawing does.
 */
function HutDrawing() {
  return (
    <svg className="rd-hut" viewBox="0 0 320 250" aria-hidden="true" focusable="false">
      <path className="rd-ground" d="M10 218h300" />
      <g className="rd-part" data-from="1">
        <path className="rd-wall" d="M60 122v96h200v-96" />
        <path className="rd-roof" d="M38 126 160 56l122 70z" />
      </g>
      <g className="rd-part rd-smoke" data-from="2">
        <path className="rd-wall" d="M218 84V62h22v38" />
        <circle cx="229" cy="46" r="7" />
        <circle cx="236" cy="30" r="9" />
        <circle cx="228" cy="12" r="6" />
      </g>
      <path className="rd-part rd-spill" data-from="6" d="M140 218h40l30 22H110z" />
      <g className="rd-part" data-from="3">
        <rect className="rd-door" x="140" y="160" width="40" height="58" rx="3" />
        <circle className="rd-knob" cx="172" cy="192" r="2" />
      </g>
      <g className="rd-part" data-from="4">
        <rect className="rd-win" x="82" y="146" width="38" height="34" rx="3" />
        <path className="rd-wall" d="M101 146v34M82 163h38" />
      </g>
      <g className="rd-part" data-from="5">
        <g className="rd-walker" transform="translate(212 188)">
          <circle cx="0" cy="-10" r="4.5" />
          <path d="M0 -5.5V12M-6 2h12M0 12l-5 10M0 12l5 10" />
        </g>
        <g className="rd-walker" transform="translate(236 192)">
          <circle cx="0" cy="-10" r="4.5" />
          <path d="M0 -5.5V12M-6 2h12M0 12l-5 10M0 12l5 10" />
        </g>
      </g>
    </svg>
  );
}

/**
 * What a bothy is, on the flat black ground: the text with the About page's reading animation on one side, a
 * bothy that is drawn as the lines are read on the other. No product claim, no panel behind the words.
 */
export function Descent({ ctx }: { ctx: PageContext }) {
  const d = ctx.t.home.descent;
  return (
    <ReadSection
      id="descent"
      className="ch-descent"
      text={
        <>
          <h2 id="descent-h">{d.heading}</h2>
          <Lines text={d.lead} />
          <figure className="ch-code rd-code">
            <figcaption>{d.codeLabel}</figcaption>
            <ul>
              {d.code.map((c) => (
                <li key={c} className="mf mf-sm">
                  {c}
                </li>
              ))}
            </ul>
            <p className="ch-small">{d.codeSource}</p>
          </figure>
          <Lines text={d.close} />
        </>
      }
      figure={<HutDrawing />}
    />
  );
}
