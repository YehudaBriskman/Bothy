// ── one theme object, both themes ────────────────────────────────────────────
//
// `HighlightStyle.define` hands its declarations to style-mod, which copies the
// VALUES verbatim into a generated stylesheet. `color: "var(--hl-kw)"` therefore
// resolves at PAINT time, in the browser, against whatever `:root[data-theme]`
// says at that moment. So there is no dark style and no light style here: there
// is one, and flipping the theme recolours the editor with no reconfiguration,
// no second palette and no JavaScript at all.
//
// That is also why this file introduces no colour. The five custom properties
// are the ones shell.css already defines for the read-only Source view and for
// markdown fences, chosen there to stay clear of the reserved --st-* status
// hues. A vendored CodeMirror theme would have quietly forked that decision.

import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export const fxHighlight = HighlightStyle.define([
  // The five that cmlang.ts can actually emit, mapped back onto the five classes
  // `.hl-com/.hl-kw/.hl-str/.hl-num/.hl-key` paint in the Source view.
  { tag: t.comment, color: 'var(--hl-com)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--hl-kw)' },
  { tag: t.string, color: 'var(--hl-str)' },
  { tag: t.number, color: 'var(--hl-num)' },
  { tag: t.propertyName, color: 'var(--hl-key)' },
]);
