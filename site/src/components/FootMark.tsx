import { layoutWord } from '../brand/cube.ts';

/**
 * The footer's giant wordmark: the brand's own drawn "BothyBox" paths (brand/cube.ts, no font), cropped by the
 * footer's edge, as dark glass letters on the ink. Three stacked layers share one set of paths (each letter is
 * defined once, inside the clip path, and reused with <use>):
 *   base  barely-there letters (#14141a on #09090c), all that shows with no script;
 *   spot  a faint fill, lit only inside a radial mask at (--mx, --my);
 *   edge  a thin bright inner outline (a 3px stroke clipped to the letters, so 1.5px shows) with a faint glow,
 *         under the same moving mask.
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
        <g fillRule="evenodd">{uses}</g>
      </svg>
      <div className="wm-lit wm-spot">
        <svg className="wm" viewBox={box} preserveAspectRatio="xMidYMin meet" focusable="false">
          <g fillRule="evenodd">{uses}</g>
        </svg>
      </div>
      <div className="wm-lit wm-edge">
        <svg className="wm" viewBox={box} preserveAspectRatio="xMidYMin meet" focusable="false">
          <g clipPath="url(#wm-clip)" fill="none">
            {letters.map((l) => (
              <use key={l.i} href={`#wm-${l.i}`} />
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}
