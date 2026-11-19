/**
 * The player in "See it in motion": a lazy island, loaded when the section is near the viewport (enhance.ts). The
 * page is complete without it (poster, caption, transcript). It does four things: un-hide the centred play button,
 * start and pause a clip on a press only (never by itself: so no autoplay to stop, and reduced motion and Save-Data
 * need no special case), pause when the clip leaves the screen or another chapter is chosen, and replay a drawn
 * preview from the top when it ends. When a recording exists (CLIP_FILES in components/new-sections/Motion.tsx) and
 * Save-Data is off, a silent, muted, looping <video preload="none"> replaces the drawn preview on the first press.
 */

type Conn = { saveData?: boolean };

function mountStage(stage: HTMLElement): void {
  const btn = stage.querySelector<HTMLButtonElement>('[data-play]');
  if (!btn) return;
  btn.hidden = false;
  let video: HTMLVideoElement | null = null;
  const saveData = (navigator as Navigator & { connection?: Conn }).connection?.saveData === true;

  const set = (on: boolean) => {
    stage.dataset.playing = String(on);
    btn.setAttribute('aria-label', (on ? btn.dataset.labelPause : btn.dataset.labelPlay) ?? '');
    if (video) void (on ? video.play().catch(() => set(false)) : video.pause());
  };
  const restart = () => {
    // the drawn preview ends after one pass: start it again from the top (the clip itself loops)
    delete stage.dataset.started;
    void stage.offsetWidth;
    stage.dataset.started = 'true';
  };
  const first = () => {
    const mp4 = stage.dataset.mp4;
    if (mp4 && !saveData) {
      video = document.createElement('video');
      video.className = 'ns-video';
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'none';
      video.setAttribute('aria-hidden', 'true');
      if (stage.dataset.webm)
        video.insertAdjacentHTML('beforeend', `<source src="${stage.dataset.webm}" type="video/webm">`);
      video.insertAdjacentHTML('beforeend', `<source src="${mp4}" type="video/mp4">`);
      stage.prepend(video);
      stage.dataset.video = 'true';
    }
    stage.dataset.started = 'true';
  };

  btn.addEventListener('click', () => {
    if (!stage.dataset.started) first();
    set(stage.dataset.playing !== 'true');
  });
  stage.querySelector('.ns-prog i')?.addEventListener('animationend', () => {
    if (!video && stage.dataset.playing === 'true') restart();
  });
  new IntersectionObserver((es) => {
    if (es.some((e) => !e.isIntersecting) && stage.dataset.playing === 'true') set(false);
  }).observe(stage);
  // choosing another chapter: stop this one and put it back to its poster
  stage.closest('[data-player]')?.addEventListener('change', () => {
    if (stage.dataset.playing === 'true') set(false);
    delete stage.dataset.started;
  });
}

export function mountNewSections(root: HTMLElement): void {
  for (const s of root.querySelectorAll<HTMLElement>('.ns-stage')) mountStage(s);
}
