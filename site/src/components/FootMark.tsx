import { layoutWord } from '../brand/cube.ts';

/**
 * The giant wordmark: the brand's own drawn "BothyBox" paths (brand/cube.ts, no font) as a thin OUTLINE, stroke only,
 * no fill. The closing band carries it (the footer, on a page with no band). Two stacked layers share one set of paths
 * (each letter is defined once, inside the clip path element, and reused with <use>):
 *   base  a faint hairline outline, all that shows with no script;
 *   edge  the same outline, bright, with a faint glow, visible only inside a radial mask at (--mx, --my): the
 *         pointer's light, which lights the edges and nothing else.
 * src/footmark.ts moves the light with the pointer; chrome.css draws it. Decorative: aria-hidden, no focus stop.
 */
export function FootMark() {
  const { letters, width } = layoutWord();
  const box = `0 0 ${width} 100`;
  const uses = letters.map((l) => <use key={l.i} href={`#wm-${l.i}`} />);
  return (
    <div className="foot-mark" aria-hidden="true" data-footmark="">
      <svg className="wm wm-base" viewBox={box} preserveAspectRatio="xMidYMin meet" focusable="false">
        <defs>
          <clipPath id="wm-clip" clipRule="evenodd">
            {letters.map((l) => (
              <path key={l.i} id={`wm-${l.i}`} transform={`translate(${l.x} 0)`} d={l.d} />
            ))}
          </clipPath>
        </defs>
        <g fillRule="evenodd" fill="none">
          {uses}
        </g>
      </svg>
      <div className="wm-lit wm-edge">
        <svg className="wm" viewBox={box} preserveAspectRatio="xMidYMin meet" focusable="false">
          <g fill="none">{uses}</g>
        </svg>
      </div>
    </div>
  );
}
