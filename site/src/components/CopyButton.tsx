/**
 * The one copy control: an icon alone (no text, no border, no background), with a small popup that says "Copy" on
 * hover or focus and "Copied" after a click. It is rendered hidden and revealed by enhance.ts (data-needs-js), and
 * src/copy.ts does the copying, so a page without script shows no dead button. The text comes from `text`, or, when
 * left out, from the nearest `[data-copy-text]` or the `<pre>` of the code block it sits in.
 */
export function CopyButton({ text }: { text?: string }) {
  return (
    <button type="button" className="cp" data-cp hidden data-needs-js aria-label="Copy command" data-copy={text}>
      <svg className="cp-i cp-copy" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="9" y="9" width="11" height="11" rx="2.5" />
        <path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" />
      </svg>
      <svg className="cp-i cp-ok" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m5 12.5 4.5 4.5L19 7.5" />
      </svg>
      <span className="cp-tip" aria-hidden="true">
        Copy
      </span>
    </button>
  );
}
