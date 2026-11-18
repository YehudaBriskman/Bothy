import { AMBER, LOCKUP_VIEWBOX, lockupInner } from '../brand/cube.ts';

/** The brand name. Not translated: it is a name. */
export const BRAND_NAME = 'BothyBox';
const ID = 'bb-lockup';

/**
 * The horizontal lockup: the Cube icon and the drawn "BothyBox" wordmark, one SVG in `currentColor` with the lid in
 * the window's amber (chrome.css turns it to the ink on a bright hour). The drawing is decoration; the name is real
 * text for screen readers, translation tools and search.
 *
 * The header draws it once (`#bb-lockup`); the footer, `reuse`, points at that drawing with <use>, so the paths are
 * in each page's HTML once. The page is prerendered and never hydrated, so the inner markup (fixed geometry from
 * brand/cube.ts, no user input) is set as a string.
 */
export function Lockup({ reuse = false }: { reuse?: boolean }) {
  const html = reuse
    ? `<use href="#${ID}"/>`
    : `<g id="${ID}">${lockupInner({ fg: 'currentColor', lid: AMBER, id: `${ID}-m`, iconClass: 'bb-icon', lidClass: 'bb-lid' })}</g>`;
  return (
    <>
      <svg
        className="lockup"
        viewBox={LOCKUP_VIEWBOX}
        aria-hidden="true"
        focusable="false"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <span className="visually-hidden" translate="no">
        {BRAND_NAME}
      </span>
    </>
  );
}
