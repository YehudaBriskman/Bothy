import { useState, type MouseEvent } from 'react';
import { Tooltip } from './Tooltip';

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
/**
 * Copy text, on a page that is NOT a secure context.
 *
 * THIS IS THE WHOLE REASON THIS FUNCTION EXISTS. `navigator.clipboard` is
 * gated on `window.isSecureContext`: https, or localhost. This box is reached
 * over plain http on a tailnet IP, so on the address people actually use, the
 * API is UNDEFINED - not blocked, not throwing, simply absent.
 *
 * The first version was `navigator.clipboard?.writeText(...)`, and the optional
 * chaining turned that into a silent no-op: right-click did nothing, reported
 * nothing, and looked broken. It passed its test because the test ran against
 * http://localhost, which IS a secure context. Testing a browser API on the
 * wrong origin is the same class of mistake as testing a route on the wrong
 * host - the code is fine and the environment is the thing under test.
 *
 * So: the modern API when it exists, and the deprecated
 * `document.execCommand('copy')` when it does not. execCommand is deprecated
 * and works everywhere; the replacement is unavailable exactly where this app
 * runs. Returns whether it worked, because a copy that silently fails is worse
 * than one that says so.
 */
async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied, or a context that advertises the API and refuses it.
      // Fall through rather than give up - execCommand may still work.
    }
  }
  // The textarea must be IN the document and focusable for the selection to
  // take, but must not scroll the page or show. `readonly` stops a mobile
  // keyboard appearing for the instant it is focused.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0';
  document.body.appendChild(ta);
  const prev = document.activeElement as HTMLElement | null;
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  prev?.focus?.();
  return ok;
}

export function Brand() {
  const where = typeof location !== 'undefined' ? location.hostname : '';
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);

  // RIGHT-CLICK COPIES THE ADDRESS. The address is the thing people actually
  // want off this page - it is what you paste into another device's browser or
  // an ssh command - and it used to sit permanently under the wordmark as a
  // line of grey mono text, spending topbar width on something read once a day.
  //
  // The context menu is the right gesture for "give me this value": it is
  // already the copy gesture everywhere else, it needs no visible control, and
  // it cannot be hit by accident. preventDefault suppresses the browser menu,
  // whose own "Copy link address" would have copied the href - the route, not
  // the host.
  //
  // The tooltip SAYS SO, because a gesture nobody is told about is a gesture
  // nobody uses. That is the whole reason the hint is in the label rather than
  // left to be discovered.
  const copy = async (e: MouseEvent) => {
    e.preventDefault();
    if (!where) return;
    const ok = await writeClipboard(where);
    setCopied(ok ? 'yes' : 'failed');
    setTimeout(() => setCopied(null), 1400);
  };

  return (
    <Tooltip
      align="start"
      label={
        copied === 'yes' ? `Copied ${where}`
          : copied === 'failed' ? 'Could not copy - select it from the address bar'
            : `${where} - right-click to copy`
      }
    >
      {/* The word is still IN THE DOM. The wordmark is painted by a CSS mask on
          this element, so the glyphs are hidden visually (font-size: 0) but the
          text stays for a screen reader, for find-in-page, and for the moment
          the .svg 404s after a bad deploy - which is the difference between a
          nameless page and a broken one. */}
      <b className="brand-wordmark" onContextMenu={copy}>Bothy</b>
    </Tooltip>
  );
}
