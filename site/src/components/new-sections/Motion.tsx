import type { CSSProperties } from 'react';
import { ns } from '../../i18n/new-sections-en.ts';
import { FilesView, OverviewView, ServicesView, TerminalView } from './Views.tsx';

/**
 * Where the owner's recorded clips go. Each id maps to the files in public/video/ once they exist; null means "no
 * recording yet", and the stage shows a drawn preview of the same script instead. Rules for a recording are in
 * public/video/README.md (silent, 6 to 12 s, 500 KB a clip, poster is the real last frame). The island starts a clip
 * only when the visitor presses play, never when Save-Data is on, and never before the press.
 */
export const CLIP_FILES: Record<string, { mp4: string; webm?: string } | null> = {
  services: null,
  files: null,
  health: null,
  install: null,
};

const STAGES = [<ServicesView key="s" flip />, <FilesView key="f" walk />, <OverviewView key="o" flip />, <TerminalView key="t" />];
const mmss = (s: number) => `0:${String(s).padStart(2, '0')}`;

/**
 * 22 See it in motion. One player with four chapters (real radio tabs, so the chapters work with no script), a
 * poster shown until the visitor presses the centred play button, and for every clip a caption and a transcript.
 * The play button is hidden until the lazy script mounts and un-hides it: without it the poster, caption and transcript
 * are the content. Nothing autoplays, so reduced motion and Save-Data need no special case beyond "poster only".
 */
export function Motion() {
  const m = ns.motion;
  return (
    <section id="motion" className="section wrap nsec" aria-labelledby="motion-h">
      <header className="section-head reveal">
        <p className="eyebrow">{m.eyebrow}</p>
        <h2 id="motion-h">{m.heading}</h2>
        <p className="lede">{m.lede}</p>
      </header>
      <div className="ns-screen ns-tabbed ns-player reveal" data-n="4" data-player>
        <div className="ns-bar">
          <span className="ns-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="ns-badge">{ns.example}</span>
        </div>
        <fieldset className="ns-tabs">
          <legend className="visually-hidden">{m.tabsLabel}</legend>
          {m.clips.map((c, i) => (
            <span key={c.id} className="ns-tabwrap">
              <input type="radio" name="clip" id={`mc-${i}`} defaultChecked={i === 0} className="ns-radio" />
              <label htmlFor={`mc-${i}`}>
                {c.name} <small>{mmss(c.len)}</small>
              </label>
            </span>
          ))}
        </fieldset>
        {m.clips.map((c, i) => {
          const f = CLIP_FILES[c.id];
          return (
            <div key={c.id} className={`ns-view ns-view-${i}`}>
              <div
                className="ns-stage"
                data-clip={c.id}
                data-playing="false"
                data-mp4={f?.mp4}
                data-webm={f?.webm}
                style={{ '--len': `${c.len}s` } as CSSProperties}
              >
                <div className="ns-body" aria-hidden="true">
                  {STAGES[i]}
                </div>
                <button
                  type="button"
                  className="ns-play"
                  hidden
                  data-needs-js
                  data-play
                  data-label-play={`${m.play} ${c.name}`}
                  data-label-pause={`${m.pause} ${c.name}`}
                  aria-label={`${m.play} ${c.name}`}
                >
                  <svg className="i-play" viewBox="0 0 14 14" aria-hidden="true">
                    <path d="M3 1.5v11l9.5-5.5z" />
                  </svg>
                  <svg className="i-pause" viewBox="0 0 14 14" aria-hidden="true">
                    <path d="M3 1.5h3v11H3zM8 1.5h3v11H8z" />
                  </svg>
                </button>
                <span className="ns-prog" aria-hidden="true">
                  <i />
                </span>
              </div>
              <p className="ns-cap">
                <b>{c.name}.</b> {c.cap}
              </p>
              <details className="ns-tx">
                <summary>{m.transcript}</summary>
                <p>{c.script}</p>
              </details>
            </div>
          );
        })}
        <p className="ns-note">{m.note}</p>
      </div>
    </section>
  );
}
