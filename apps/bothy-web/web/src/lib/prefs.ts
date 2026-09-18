// Per-browser preferences the Settings area adds - the pure half.
//
// Three versioned keys, and every value is re-checked on the way in, for the
// reason reading.ts gives: this is hand-editable, it survives deploys, and it is
// fed straight into attributes, timers and routes. A stored `{"pollSeconds": 0}`
// must not become a poll loop with no delay.
//
//   bothy-appearance-v1   table density, motion, accent, document font
//   bothy-layout-v1       landing page, Overview section order, hidden panels
//   bothy-data-v1         poll interval, default chart range
//
// ALL PER BROWSER, and the page says so beside each control. docs/plans/
// control-and-settings.md §6b is still the rule: a server-side preference store is
// a write path with a threat model, and none of these needs one - a poll interval
// or a density is a fact about the screen and the network you are on.
//
// IMPORTS NOTHING, so checks/run.sh can compile it with a bare tsc and run
// checks/prefs.mjs against it. The existing keys (portal-theme*, bothy-reading-v1,
// bothy-collapsed-groups-v1, ...) are not moved here and keep their names.

export const APPEARANCE_KEY = 'bothy-appearance-v1';
export const LAYOUT_KEY = 'bothy-layout-v1';
export const DATA_KEY = 'bothy-data-v1';

// ── appearance ──────────────────────────────────────────────────────────────

export type Density = 'comfortable' | 'compact';
export type Motion = 'system' | 'reduce';
/** `theme` means "whatever the active theme declares". The others override the
 *  chrome accent on Bothy's two built-in palettes only - see index.css. */
export type Accent = 'theme' | 'violet' | 'cyan';
export type DocFont = 'sans' | 'serif';

export interface Appearance {
  density: Density;
  motion: Motion;
  accent: Accent;
  docFont: DocFont;
}

export const APPEARANCE_DEFAULT: Appearance = {
  density: 'comfortable', motion: 'system', accent: 'theme', docFont: 'sans',
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;

export const DENSITIES: readonly Density[] = ['comfortable', 'compact'];
export const MOTIONS: readonly Motion[] = ['system', 'reduce'];
export const ACCENTS: readonly Accent[] = ['theme', 'violet', 'cyan'];
export const DOC_FONTS: readonly DocFont[] = ['sans', 'serif'];

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const j: unknown = JSON.parse(raw);
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseAppearance(raw: string | null): Appearance {
  const j = parseObject(raw);
  if (!j) return APPEARANCE_DEFAULT;
  return {
    density: oneOf(j.density, DENSITIES, APPEARANCE_DEFAULT.density),
    motion: oneOf(j.motion, MOTIONS, APPEARANCE_DEFAULT.motion),
    accent: oneOf(j.accent, ACCENTS, APPEARANCE_DEFAULT.accent),
    docFont: oneOf(j.docFont, DOC_FONTS, APPEARANCE_DEFAULT.docFont),
  };
}

/** The attributes stamped on <html>. A default is REMOVED rather than written, so
 *  a browser that never opened Settings carries no attribute at all and every
 *  stylesheet rule keyed on one is inert. */
export function appearanceAttrs(a: Appearance): Record<string, string | null> {
  return {
    'data-density': a.density === 'compact' ? 'compact' : null,
    'data-motion': a.motion === 'reduce' ? 'reduce' : null,
    'data-accent': a.accent === 'theme' ? null : a.accent,
    'data-doc-font': a.docFont === 'serif' ? 'serif' : null,
  };
}

// ── layout ──────────────────────────────────────────────────────────────────

/** Where a bare visit to the app lands. Paths the router serves; checked
 *  against LIVE_PATHS by checks/prefs.mjs so a renamed page cannot become a
 *  landing into the not-found page. */
export const LANDINGS = [
  { path: '/', label: 'Overview' },
  { path: '/control', label: 'Control' },
  { path: '/control/services', label: 'Services' },
  { path: '/files', label: 'Files' },
] as const;
export type Landing = (typeof LANDINGS)[number]['path'];

export type SectionOrder = 'bothy-first' | 'projects-first';
export const SECTION_ORDERS: readonly SectionOrder[] = ['bothy-first', 'projects-first'];

/** Overview panels that may be hidden. The status line and the attention strip
 *  are NOT here: "is anything broken" is the page's reason to exist, and a
 *  preference that could hide it would be a preference to be told less. */
export const OVERVIEW_PANELS = [
  { id: 'quickview', label: 'Box at a glance', hint: 'CPU, memory, disk, network and load, under the status line.' },
  { id: 'vitals', label: 'Box vitals', hint: 'Host CPU, memory and network charts.' },
  { id: 'ui', label: 'Open a UI', hint: 'Every browsable service, projects and stack.' },
  { id: 'disk', label: 'Data & disk', hint: 'Volume sizes by system.' },
  { id: 'top', label: 'Busiest containers', hint: 'The top containers by CPU and memory.' },
] as const;
export type OverviewPanel = (typeof OVERVIEW_PANELS)[number]['id'];

export interface Layout {
  landing: Landing;
  sectionOrder: SectionOrder;
  hiddenPanels: OverviewPanel[];
}

export const LAYOUT_DEFAULT: Layout = { landing: '/', sectionOrder: 'bothy-first', hiddenPanels: [] };

export function parseLayout(raw: string | null): Layout {
  const j = parseObject(raw);
  if (!j) return LAYOUT_DEFAULT;
  const panelIds = OVERVIEW_PANELS.map((p) => p.id) as readonly string[];
  const hidden = Array.isArray(j.hiddenPanels)
    ? [...new Set(j.hiddenPanels.filter((x): x is OverviewPanel => typeof x === 'string' && panelIds.includes(x)))].sort()
    : [];
  return {
    landing: oneOf(j.landing, LANDINGS.map((l) => l.path), LAYOUT_DEFAULT.landing),
    sectionOrder: oneOf(j.sectionOrder, SECTION_ORDERS, LAYOUT_DEFAULT.sectionOrder),
    hiddenPanels: hidden,
  };
}

/**
 * Where to send a FRESH load, or null to stay.
 *
 * Only a bare entry - no hash, or `#/` exactly - is redirected, and only once per
 * page load (the caller runs this before the router mounts). A deep link always
 * wins, and so does clicking Overview afterwards: a landing preference that made
 * the Overview unreachable would be a trap wearing a setting's name.
 */
export function landingRedirect(hash: string, layout: Layout): string | null {
  const bare = hash === '' || hash === '#' || hash === '#/';
  if (!bare || layout.landing === '/') return null;
  return `#${layout.landing}`;
}

/** Sections in the order the Overview draws them. Unknown sections keep their
 *  relative order after the two named ones. */
export function orderSections<T extends { key: string }>(sections: T[], order: SectionOrder): T[] {
  if (order === 'bothy-first') return sections;
  const rank = (k: string) => (k === 'projects' ? 0 : k === 'bothy' ? 1 : 2);
  return sections.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s.key) - rank(b.s.key) || a.i - b.i).map((x) => x.s);
}

// ── data ────────────────────────────────────────────────────────────────────

export const POLL_CHOICES = [10, 30, 60] as const;
export type PollSeconds = (typeof POLL_CHOICES)[number];
export const CHART_RANGES = ['15m', '1h', '6h', '24h'] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

export interface DataPrefs {
  pollSeconds: PollSeconds;
  chartRange: ChartRange;
}

export const DATA_DEFAULT: DataPrefs = { pollSeconds: 10, chartRange: '1h' };

export function parseData(raw: string | null): DataPrefs {
  const j = parseObject(raw);
  if (!j) return DATA_DEFAULT;
  const poll = POLL_CHOICES.find((p) => p === j.pollSeconds) ?? DATA_DEFAULT.pollSeconds;
  return { pollSeconds: poll, chartRange: oneOf(j.chartRange, CHART_RANGES, DATA_DEFAULT.chartRange) };
}

// ── storage, never throwing ─────────────────────────────────────────────────

export function readRaw(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode, quota */ }
}

export const readAppearance = (): Appearance => parseAppearance(readRaw(APPEARANCE_KEY));
export const readLayout = (): Layout => parseLayout(readRaw(LAYOUT_KEY));
export const readData = (): DataPrefs => parseData(readRaw(DATA_KEY));

/** Stamp the appearance attributes. Called before React mounts and on change. */
export function stampAppearance(a: Appearance, el: { setAttribute(n: string, v: string): void; removeAttribute(n: string): void }): void {
  for (const [name, v] of Object.entries(appearanceAttrs(a))) {
    if (v === null) el.removeAttribute(name);
    else el.setAttribute(name, v);
  }
}

// ── every key this app keeps in a browser ───────────────────────────────────
//
// For the "what this browser holds" block. Written out, because a key is only
// worth clearing if somebody can say what clearing it does. `bothy-dev-*` keys are
// listed so a browser used for development can see them; they do nothing in a
// build.

export interface KnownKey {
  key: string;
  what: string;
  /** Clearing it resets something visible; `false` for the theme's two
   *  derived keys, which are rewritten from the selection on the next load. */
  resettable: boolean;
}

export const KNOWN_KEYS: readonly KnownKey[] = [
  { key: 'portal-theme', what: 'Which theme you picked', resettable: true },
  { key: 'portal-theme-appearance', what: "The picked theme's light or dark, for the first frame", resettable: false },
  { key: 'portal-theme-is-user', what: 'Whether the picked theme is a file on the box', resettable: false },
  { key: APPEARANCE_KEY, what: 'Density, motion, accent and document font', resettable: true },
  { key: LAYOUT_KEY, what: 'Landing page, Overview order and hidden panels', resettable: true },
  { key: DATA_KEY, what: 'Poll interval and default chart range', resettable: true },
  { key: 'bothy-reading-v1', what: 'Reading size in Files', resettable: true },
  { key: 'bothy-collapsed-groups-v1', what: 'Service groups you collapsed', resettable: true },
  { key: 'bothy-control-nav-v1', what: 'Whether the Control menu is collapsed', resettable: true },
  { key: 'bothy-settings-nav-v1', what: 'Settings blocks you expanded', resettable: true },
  { key: 'bothy-files-panes-v1', what: 'Pane widths in Files', resettable: true },
  { key: 'bothy-read-recent-v1', what: 'Recently opened documents', resettable: true },
  { key: 'bothy-dev-roles', what: 'Development only: roles to draw as held', resettable: true },
  { key: 'bothy-dev-kube-outcome', what: 'Development only: a forced cluster outcome', resettable: true },
  { key: 'bothy-dev-config-outcome', what: 'Development only: a forced config outcome', resettable: true },
  { key: 'bothy-dev-control-outcome', what: 'Development only: a forced container outcome', resettable: true },
  { key: 'bothy-dev-admin-outcome', what: 'Development only: a forced admin outcome', resettable: true },
];
