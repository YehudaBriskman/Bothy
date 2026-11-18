import type { PageContext } from '../page-context.ts';

/**
 * The sky's controls: the hour dial, "Now" and pause. Rendered hidden; src/enhance-sky.ts reveals
 * them once the live sky (or its CSS still) is running, because they do nothing without script. Words are in en.ts.
 */
export function SkyControls({ ctx }: { ctx: PageContext }) {
  const s = ctx.t.home.sky;
  return (
    <div className="sky-ui" data-sky-ui hidden role="group" aria-label={s.group}>
      <div className="sky-dial">
        <svg
          className="sky-glyph"
          data-sky-sun
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
          <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M5.3 18.7 7 17M17 7l1.7-1.7" />
        </svg>
        <svg className="sky-glyph" data-sky-moon viewBox="0 0 24 24" aria-hidden="true" {...{ hidden: true }}>
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" fill="currentColor" />
        </svg>
        <label className="sky-sr" htmlFor="sky-hour">
          {s.hour}
        </label>
        <input id="sky-hour" data-sky-hour type="range" min="0" max="24" step="0.25" defaultValue="12" />
        <output htmlFor="sky-hour" data-sky-out />
      </div>
      <button type="button" data-sky-now hidden>
        {s.now}
      </button>
      <button type="button" data-sky-pause data-pause={s.pause} data-play={s.play}>
        {s.pause}
      </button>
      <pre className="sky-dbg" data-sky-dbg hidden />
    </div>
  );
}
