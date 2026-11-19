/**
 * The one copy control: an icon alone (no text, no border, no background), with a small popup that says "Copy" on
 * hover or focus and "Copied" after a click. It is rendered as an empty hidden button: src/copy.ts (loaded by
 * enhance.ts only on a page that has one) draws the icons and the popup, names it and reveals it, so a page without
 * script shows no dead button and the HTML stays small. The text comes from `text`, or, when left out, from the
 * nearest `[data-copy-text]` or the `<pre>` of the code block it sits in.
 */
export function CopyButton({ text }: { text?: string }) {
  return <button type="button" className="cp" data-cp hidden aria-label="Copy command" data-copy={text} />;
}
