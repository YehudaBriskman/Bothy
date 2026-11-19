import { ns } from '../../i18n/new-sections-en.ts';
import { FilesView, HealthView, ModulesView, ServicesView } from './Views.tsx';

/**
 * A real recording, when there is one. null means "none yet": the section plays the scripted clip (new-sections.ts),
 * which is what the page shows today. When the files exist, put them in public/video/, point this at them and the
 * player plays the recording instead, with the same controls and chapters (see public/video/README.md). Nothing is
 * downloaded before a press on play, and never with Save-Data on.
 */
export const CLIP_FILE: { mp4: string; webm?: string } | null = null;

const m = ns.motion;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, '0')}`;
const TABS = [
  ['services', 'Services'],
  ['files', 'Files'],
  ['health', 'Health'],
  ['modules', 'Modules'],
] as const;

/**
 * 22 See it move. A faux screen recording: a framed console window that plays a scripted clip (a cursor, typing, a
 * load, tab changes) on its own timeline, with a video player's controls under it. Everything inside the window is
 * inert, like pixels in a video; only the controls work. The page without script shows the first frame, a one-line
 * caption and a transcript; the play button and controls appear when the lazy script has mounted. Nothing autoplays.
 */
export function Motion() {
  return (
    <section id="motion" className="section nsec" aria-labelledby="motion-h">
      <header className="section-head reveal">
        <p className="eyebrow">{m.eyebrow}</p>
        <h2 id="motion-h">{m.heading}</h2>
        <p className="lede">{m.lede}</p>
      </header>
      <figure
        className="cvp reveal"
        data-clip=""
        data-playing="false"
        data-len={m.len}
        data-label-play={m.play}
        data-label-pause={m.pause}
        data-mp4={CLIP_FILE?.mp4}
        data-webm={CLIP_FILE?.webm}
      >
        <div className="cvp-stage">
          <div className="cv" data-tab="services" inert aria-hidden="true">
            <div className="cv-bar">
              <span className="ns-dots">
                <i />
                <i />
                <i />
              </span>
              <span className="cv-spin" />
              <span className="ns-badge">{ns.example}</span>
            </div>
            <div className="cv-load">
              <i />
            </div>
            <div className="cv-nav">
              {TABS.map(([id, name]) => (
                <span key={id} data-n={id}>
                  {name}
                </span>
              ))}
            </div>
            <div className="cv-body">
              <div className="cv-v" data-v="services">
                <ServicesView />
              </div>
              <div className="cv-v" data-v="files">
                <FilesView />
              </div>
              <div className="cv-v" data-v="health">
                <HealthView />
              </div>
              <div className="cv-v" data-v="modules">
                <ModulesView />
              </div>
            </div>
            <div className="cv-dock" translate="no" dir="ltr">
              <p className="cmd">
                <span className="nv-pr">$ </span>
                <span
                  className="cv-field cmd-t"
                  data-type="bothy module add node-metrics"
                  data-start="22.8"
                  data-dur="2"
                />
              </p>
              <p className="nv-dim o" data-at="25.2">
                Requires edge: installed
              </p>
              <p className="nv-dim o" data-at="25.9">
                Pulling node-exporter, checked against checksums.txt
              </p>
              <p className="nv-ok o" data-at="26.6">
                Added node-metrics
              </p>
            </div>
            <span className="cv-cur">
              <i />
              <svg viewBox="0 0 20 24" aria-hidden="true">
                <path d="M2 1.5v18l4.6-4.3 3.1 7 3-1.3-3.1-6.9H16z" />
              </svg>
            </span>
          </div>
          <button type="button" className="cvp-play" hidden data-play aria-label={m.play}>
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 1.5v11l9.5-5.5z" />
            </svg>
          </button>
        </div>
        <div className="cvc" hidden>
          <div
            className="cvc-bar"
            role="slider"
            tabIndex={0}
            aria-label={m.scrub}
            aria-valuemin={0}
            aria-valuemax={m.len}
            aria-valuenow={0}
            aria-valuetext={`0:00 / ${mmss(m.len)}`}
          >
            <i className="cvc-fill" />
            {m.chapterList.slice(1).map((c) => (
              <span key={c.id} className="cvc-tick" style={{ insetInlineStart: `${(c.t / m.len) * 100}%` }} />
            ))}
          </div>
          <div className="cvc-row">
            <button type="button" className="cvc-btn" data-play aria-label={m.play}>
              <svg className="i-play" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M3 1.5v11l9.5-5.5z" />
              </svg>
              <svg className="i-pause" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M3 1.5h3v11H3zM8 1.5h3v11H8z" />
              </svg>
            </button>
            <span className="cvc-time">
              <span data-now>0:00</span> / {mmss(m.len)}
            </span>
            <span className="cvc-ch" role="group" aria-label={m.chapters}>
              {m.chapterList.map((c) => (
                <button key={c.id} type="button" data-t={c.t}>
                  {c.name}
                </button>
              ))}
            </span>
          </div>
        </div>
        <figcaption className="cvp-cap">{m.caption}</figcaption>
        <p className="visually-hidden">{m.transcript}</p>
      </figure>
    </section>
  );
}
