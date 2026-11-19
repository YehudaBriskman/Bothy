/** The copy control as an HTML string, for the docs' markdown renderer (the same markup as components/CopyButton.tsx). */
const ICONS =
  '<svg class="cp-i cp-copy" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>' +
  '<svg class="cp-i cp-ok" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

export const COPY_MARKUP = `<button type="button" class="cp" data-cp hidden data-needs-js aria-label="Copy command">${ICONS}<span class="cp-tip" aria-hidden="true">Copy</span></button>`;
