/**
 * The script of the clip in "See it move": data only. The player (new-sections.ts) paints the whole window for any
 * time T from these arrays, so scrubbing, looping and pausing are one call.
 *
 * An act is one thing the pointer does: it travels (a Bezier curve, `d` seconds) to the element marked data-h="<to>",
 * rests on it (that element shows its hover state), and presses at `t`. A press ripples, applies the state `s` and, with
 * `l`, runs the load bar for l seconds. k:false is a move with no press (a hover). EXTRA is state that changes on its
 * own (a load finishing, a tooltip). Typed text, timed lines, drawn charts and toasts are in the markup (views.ts) as
 * data-type, data-at and data-draw. State keys are set on the window as data-<key>; styles/clip.css reads them.
 *
 * What is real and what is not is written in public/video/README.md ("illustrative, not shipped"). Every name, port and
 * status comes from the example fixtures; log lines and chart shapes are invented and carry no numbers.
 */

export type State = Record<string, string>;
export type Act = { t: number; to: string; at?: [number, number]; d?: number; s?: State; l?: number; k?: boolean };
export type Extra = { t: number; s: State };

/** The clip's length in seconds, and where each chapter starts (the bar's ticks and the chapter buttons read these). */
export const LEN = 78;
export const CHAPTERS = [0, 18.5, 39, 48.5, 55.5, 65.5] as const;

export const INIT: State = {
  app: 'bothy', // which browser tab is showing
  tab: 'services', // the console's own tab
  foc: '', // which text field has the caret
  chip: 'all',
  filt: '0',
  sel: '',
  dr: '', // the detail drawer: '' | 'open' | 'logs'
  svc: 'starting', // wiki: starting | up | restart | up2
  tg: '0',
  ck: '0',
  pop: '',
  menu: '',
  lv: 'all',
  q: '0',
  fol: '1',
  exp: '0',
  doc: '',
  fq: '0',
  rg: '1h', // the Health chart's range
  dock: '',
  mod: '0',
  g: '0', // the example Grafana row exists in the list
  g2: '0', // its browser tab exists
  gr: '6h', // the example dashboard's range
  pk: '',
  tt: '',
};

export const ACTS: Act[] = [
  // Services
  { t: 1.9, to: 'refresh', l: 0.8 },
  { t: 3.3, to: 'chip-running', d: 0.7, s: { chip: 'running' } },
  { t: 4.6, to: 'chip-all', d: 0.6, s: { chip: 'all' } },
  { t: 6.0, to: 'search', d: 0.8, s: { foc: 'search' } },
  { t: 8.6, to: 'row-wiki', at: [0.15, 0.5], d: 0.8, s: { foc: '', sel: 'wiki', dr: 'open' }, l: 0.6 },
  { t: 11.0, to: 'toggle', d: 0.8, s: { tg: '1' } },
  { t: 12.4, to: 'check', d: 0.6, s: { ck: '1' } },
  { t: 13.9, to: 'restart', d: 0.8, s: { pop: '1' } },
  { t: 15.3, to: 'confirm', d: 0.7, s: { pop: '', svc: 'restart' }, l: 1.0 },
  // Logs
  { t: 19.0, to: 'tab-logs', d: 1.0, s: { dr: 'logs' }, l: 0.6 },
  { t: 25.8, to: 'level', d: 0.9, s: { menu: 'lv' } },
  { t: 27.4, to: 'lv-error', d: 0.7, s: { menu: '', lv: 'error' } },
  { t: 28.9, to: 'lq', d: 0.8, s: { foc: 'lq' } },
  { t: 32.8, to: 'follow', d: 0.9, s: { fol: '0' } },
  { t: 35.0, to: 'jump', d: 0.8, s: { fol: '1' } },
  { t: 36.8, to: 'copy-line', d: 0.9 },
  // Notes
  { t: 40.6, to: 'nav-files', d: 1.0, s: { tab: 'files', dr: '', sel: '', filt: '0' }, l: 0.5 },
  { t: 42.2, to: 'folder', d: 0.7, s: { exp: '1' } },
  { t: 43.6, to: 'note-first', d: 0.6, s: { doc: 'first' }, l: 0.4 },
  { t: 45.0, to: 'fsearch', d: 0.7, s: { foc: 'fs' } },
  { t: 47.4, to: 'note-ports', d: 0.8, s: { foc: '', fq: '1', doc: 'ports' }, l: 0.4 },
  // Health
  { t: 50.0, to: 'nav-health', d: 1.0, s: { tab: 'health' }, l: 0.5 },
  { t: 52.4, to: 'range-6h', d: 0.9, s: { rg: '6h' } },
  { t: 53.8, to: 'range-24h', d: 0.5, s: { rg: '24h' } },
  // Install
  { t: 57.0, to: 'nav-modules', d: 1.0, s: { tab: 'modules' }, l: 0.5 },
  { t: 58.4, to: 'terminal', d: 0.7, s: { dock: '1', foc: 'cmd' } },
  // Grafana (illustrative)
  { t: 67.0, to: 'nav-services', d: 1.1, s: { tab: 'services', g: '1', dock: '' }, l: 0.5 },
  { t: 69.2, to: 'open-grafana', d: 1.0, s: { g2: '1', app: 'grafana' }, l: 0.9 },
  { t: 72.0, to: 'cpu-pt', d: 0.9, k: false },
  { t: 74.4, to: 'picker', d: 0.8, s: { pk: '1' } },
  { t: 75.8, to: 'pk-24h', d: 0.6, s: { pk: '', gr: '24h' }, l: 0.6 },
  { t: 77.4, to: 'tab-bothy', d: 0.9, s: { app: 'bothy' } },
];

export const EXTRA: Extra[] = [
  { t: 7.3, s: { filt: '1', foc: '' } },
  { t: 9.6, s: { svc: 'up' } },
  { t: 16.4, s: { svc: 'up2' } },
  { t: 30.1, s: { q: '1', foc: '' } },
  { t: 61.0, s: { foc: '' } },
  { t: 65.0, s: { mod: '1' } },
  { t: 72.0, s: { tt: '1' } },
  { t: 73.4, s: { tt: '' } },
];

/** Loads that are not tied to a press: the install. (The dashboard's first load runs from the press on Open.) */
export const LOADS: [number, number][] = [[61.0, 65.0]];
