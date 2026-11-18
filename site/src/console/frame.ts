/**
 * The glass frame around the console views: three kinds of thing, kept apart.
 *
 *   .cf-*            the frame itself (site chrome: glass, tab labels, captions). Styled by src/console/frame.css
 *                    with the SITE's tokens.
 *   .console-frame   the console's own world: its tokens, its components. Styled by the generated console.css, which
 *                    is the console's stylesheet scoped under this one class. No site token reaches it; none of its
 *                    tokens reaches out.
 *   captions         site copy beside the frame, outside `.console-frame`.
 *
 * The tabs are radio inputs and labels: a real, keyboard-reachable control (Tab to the group, arrow keys to change
 * view) that switches the panel in CSS alone, so the content never needs JavaScript. Every panel is in the HTML for
 * crawlers and for readers with styles off; a hidden panel is `display: none` and so out of the accessibility tree.
 */

import { esc } from './components.ts';

export interface Tab {
  id: 'services' | 'files' | 'health' | 'modules';
  label: string;
  /** The line beside the frame while this tab is open. Says only what docs/guide documents. */
  caption: string;
}

/** English strings for the frame. A locale adds its own object of the same shape. */
export interface FrameStrings {
  /** The label of the radio group. */
  groupLabel: string;
  /** The label of the console region. */
  frameLabel: string;
  /** The badge on the frame: nothing in it is live. */
  badge: string;
  tabs: Tab[];
}

export const EN: FrameStrings = {
  groupLabel: 'Console view',
  frameLabel: 'Example console',
  badge: 'Example data',
  tabs: [
    {
      id: 'services',
      label: 'Services',
      caption: 'Every service it finds by asking Docker, with its state, ports and image on one page.',
    },
    {
      id: 'files',
      label: 'Files',
      caption: 'A reader for the notes and files kept on the machine, with the last change to each.',
    },
    {
      id: 'health',
      label: 'Health',
      caption: 'The health strip: one glance at whether the machine is all right, each number a way in.',
    },
    {
      id: 'modules',
      label: 'Modules',
      caption:
        'What is installed is a list of modules, each with its memory cost. This one is the command line, not the console.',
    },
  ],
};

/** `prefix` keeps ids unique when a page holds more than one frame. */
export function renderFrame(panels: Record<Tab['id'], string>, s: FrameStrings = EN, prefix = 'cf'): string {
  const tabs = s.tabs
    .map(
      (t, i) =>
        `<input class="cf-r" type="radio" name="${prefix}-view" id="${prefix}-v-${t.id}" value="${t.id}"${i === 0 ? ' checked' : ''} /><label class="cf-tab" for="${prefix}-v-${t.id}">${esc(t.label)}</label>`,
    )
    .join('');
  const body = s.tabs
    .map(
      (t) => `<div class="cf-panel cf-panel-${t.id}" role="group" aria-label="${esc(t.label)}">${panels[t.id]}</div>`,
    )
    .join('');
  const caps = s.tabs.map((t) => `<p class="cf-cap cf-cap-${t.id}">${esc(t.caption)}</p>`).join('');
  return [
    '<figure class="cf">',
    '<div class="cf-glass">',
    `<div class="cf-bar"><div class="cf-tabs" role="radiogroup" aria-label="${esc(s.groupLabel)}">${tabs}</div><p class="cf-badge">${esc(s.badge)}</p></div>`,
    `<div class="console-frame" dir="ltr" lang="en" role="group" aria-label="${esc(s.frameLabel)}">${body}</div>`,
    '</div>',
    `<figcaption class="cf-caps">${caps}</figcaption>`,
    '</figure>',
  ].join('');
}

/**
 * The per-tab selectors, generated from the tab list so a new tab cannot be forgotten in the stylesheet. A panel and
 * its caption show when their radio is checked (`:has`, Baseline 2023); where `:has` is missing every panel shows,
 * which is a long page and not a broken one.
 */
export function tabRules(tabs: Tab[]): string {
  const on = (t: Tab) => `.cf:has(.cf-r[value='${t.id}']:checked)`;
  const rules = tabs.map(
    (t) => `${on(t)} .cf-panel.cf-panel-${t.id}, ${on(t)} .cf-cap.cf-cap-${t.id} { display: block; }`,
  );
  return ['@supports selector(:has(*)) {', '.cf .cf-panel, .cf .cf-cap { display: none; }', ...rules, '}'].join('\n');
}
