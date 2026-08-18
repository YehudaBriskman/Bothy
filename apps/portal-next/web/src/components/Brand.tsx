// The Bothy mark.
//
// A bothy is a small hut in the Scottish hills left unlocked for whoever needs
// shelter - which is what this box is: one machine quietly holding everything,
// open to anyone on the tailnet. The mark is that hut with the door open and the
// light on, and the lit doorway is the only coloured part, so the logo says the
// same thing the page does: something is running in there.
//
// The geometry is duplicated in exactly two other places, both generated from
// the same numbers - public/favicon.svg and scripts/gen-icons.py. If you move a
// coordinate here, move it there; there is no build step that would catch a
// drift, because a favicon is never rendered by this app.

export function BothyMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="brand-svg"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.4 11.6 L12 4.2 L21.6 11.6" />
        <path d="M5.6 10.6 V20.4 H18.4 V10.6" />
      </g>
      {/* The one coloured element in the whole mark. */}
      <path className="brand-door" d="M10.15 20.4 V15.3 a1.85 1.85 0 0 1 3.7 0 V20.4 Z" />
    </svg>
  );
}

/**
 * The topbar lockup: mark, wordmark, and the address you actually reached the
 * box at.
 *
 * The subtitle is read from `location.hostname` at RUN TIME and is never
 * written down. Two reasons, and the second is the important one: it is
 * honest - it shows the name layer when you came in by name and the bare IP when
 * you came in by IP, which is exactly the distinction that matters on this box
 * while the name layer is dormant - and this repo is public, so the tailnet
 * address does not belong in it. (The old lockup hardcoded "an address, not a name",
 * which was wrong for every visitor arriving on the IP.)
 */
export function Brand() {
  const where = typeof location !== 'undefined' ? location.hostname : '';
  return (
    <>
      <span className="brand-mark"><BothyMark size={19} /></span>
      <span className="brand-text">
        {/* The word is still IN THE DOM. The wordmark is painted by a CSS mask
            on this element, so the glyphs are hidden visually (font-size: 0) but
            the text stays for a screen reader, for find-in-page, and for the
            moment the .svg 404s after a bad deploy - which is the difference
            between a nameless page and a broken one. */}
        <b className="brand-wordmark">Bothy</b>
        <small title={where}>{where}</small>
      </span>
    </>
  );
}
