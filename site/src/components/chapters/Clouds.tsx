import { href } from '../../config.ts';

/**
 * The clouds that part (section 04): three of the story's own photographs as layers behind a chapter's card. As the
 * chapter scrolls past, styles/chosen.css moves the far layer 8 %, the middle 16 % and the near one 30 % (and fades it).
 * Decorative and lazy: the same files the sky scenes already load, so they usually come from the cache. Without
 * scroll-driven animation or with reduced motion only the far layer shows, still.
 */
export function Clouds({ order }: { order: 'a' | 'b' }) {
  const far = order === 'a' ? 'twilight' : 'cumulus';
  const mid = order === 'a' ? 'cumulus' : 'twilight';
  const img = (name: string, cls: string) => (
    <img
      className={cls}
      src={href(`scene-mock/img/${name}-desk.avif`)}
      alt=""
      loading="lazy"
      decoding="async"
      width={1920}
      height={1080}
    />
  );
  return (
    <div className="ds-clouds" aria-hidden="true">
      {img(far, 'ds-far')}
      {img(mid, 'ds-mid')}
      {img('glow', 'ds-near')}
    </div>
  );
}
