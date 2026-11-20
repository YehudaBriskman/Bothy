import type { ReactNode } from 'react';

/**
 * A reading wheel: the words of one section stacked in big type, centred on a flat black ground. With script (and
 * motion) the section pins and the whole stack rolls up as you scroll, like a wheel: the line at the centre is lit
 * and read (a sweep of light runs across it), the lines above and below are dimmer and smaller, then the section
 * lets go (src/wheel.ts). Without script, or with reduced motion, it is the same words as plain big text, all lit.
 * Every line carries `wl`; the script reads nothing else.
 */
/** One wheel line each. */
export function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <>
      {lines.map((s) => (
        <p key={s} className="wl">
          {s}
        </p>
      ))}
    </>
  );
}

export function ReadWheel({
  id,
  className,
  heading,
  children,
}: {
  id: string;
  className: string;
  heading: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`ch ${className} ch-wheel`} aria-labelledby={`${id}-h`} data-wheel>
      <div className="wh-track">
        <div className="wh-stage">
          <h2 id={`${id}-h`} className="wh-head">
            {heading}
          </h2>
          <div className="wh-view">
            <div className="wh-roll">{children}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
