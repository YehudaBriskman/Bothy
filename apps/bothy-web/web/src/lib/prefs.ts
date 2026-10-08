// Per-browser preferences the Settings area adds - the pure half.
//
// Three versioned keys, and every value is re-checked on the way in, for the
// reason reading.ts gives: this is hand-editable, it survives deploys, and it is
// fed straight into attributes, timers and routes. A stored `{"pollSeconds": 0}`
// must not become a poll loop with no delay.
//
//   bothy-appearance-v1       table density, motion, accent, document font
//   bothy-layout-v1           landing page, Overview section order, hidden panels
//   bothy-data-v1             poll interval, default chart range
//   bothy-settings-groups-v1  which groups of the Settings nav are folded open
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

/**
 * The Settings nav's folded groups.
 *
 * DELIBERATELY NOT `bothy-settings-nav-v1`. That key is already taken, by
 * SettingBlock, and despite its name it holds BLOCK state - which blocks on a
 * page you collapsed, as `{ id: false }`. A nav value written under it would
 * parse there as a list of collapsed blocks named `you`, `look`, `data`... and
 * the Settings pages would quietly fold whatever matched. This is the same trap
 * lib/collapse.ts records about `portal-open-groups`: a key whose shape still
 * parses after its meaning moved is worse than one that throws.
 */
export const SETTINGS_GROUPS_KEY = 'bothy-settings-groups-v1';

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

/**
 * THE PRIMARY ONE. Two dashboards here are uniform BY CONSTRUCTION - the
 * quick-view strip has fixed row tracks and emits a trend row even when it is
 * empty, and the Control landing's three glance cards are one shape - so neither
 * has a most-important thing, and a reader who opens the page for the disk every
 * morning reads five identical tiles every morning.
 *
 * The reader says which one that is, and it persists per browser, like every
 * other layout preference. NOT derived from the numbers: see
 * docs/brand/foundations/space-and-layout.md - a dashboard that promotes
 * whatever is worst re-draws itself under the reader, and the tile you were
 * looking for is wherever the box's mood put it. A degraded metric is badged
 * where it stands.
 *
 * `null` means no choice, which is the default and must stay a real state: it is
 * what every browser that has never touched this has, and the pages must look
 * right in it.
 */
export const QUICK_TILES = [
  { id: 'cpu', label: 'CPU' },
  { id: 'mem', label: 'Memory' },
  { id: 'disk', label: 'Disk' },
  { id: 'net', label: 'Ethernet' },
  { id: 'uptime', label: 'Uptime' },
] as const;
export type QuickTile = (typeof QUICK_TILES)[number]['id'];

/** The Control landing's three glance cards. Needs attention and Quick links are
 *  deliberately not here: one is the page's exception list and the other its
 *  navigation, and neither is a thing to watch. */
export const CONTROL_CARDS = [
  { id: 'cluster', label: 'Cluster' },
  { id: 'edge', label: 'Edge and routes' },
  { id: 'activity', label: 'Recent activity' },
] as const;
export type ControlCard = (typeof CONTROL_CARDS)[number]['id'];

export interface Layout {
  landing: Landing;
  sectionOrder: SectionOrder;
  hiddenPanels: OverviewPanel[];
  /** The quick-view tile the reader watches, or null for "none of them". */
  primaryTile: QuickTile | null;
  /** The Control landing card the reader watches, or null. */
  primaryCard: ControlCard | null;
}

export const LAYOUT_DEFAULT: Layout = {
  landing: '/', sectionOrder: 'bothy-first', hiddenPanels: [], primaryTile: null, primaryCard: null,
};

/** Pressing the control on the tile that is already primary CLEARS it, so "none"
 *  stays reachable without a second control to reach it with. */
export function togglePrimary<T extends string>(current: T | null, id: T): T | null {
  return current === id ? null : id;
}

export function parseLayout(raw: string | null): Layout {
  const j = parseObject(raw);
  if (!j) return LAYOUT_DEFAULT;
  const panelIds = OVERVIEW_PANELS.map((p) => p.id) as readonly string[];
  const hidden = Array.isArray(j.hiddenPanels)
    ? [...new Set(j.hiddenPanels.filter((x): x is OverviewPanel => typeof x === 'string' && panelIds.includes(x)))].sort()
    : [];
  // A stored primary that is not one of the ids this build draws comes back as
  // null, not as itself: the value reaches a className and an aria-pressed, and
  // a renamed tile must leave the strip with NO primary rather than with one
  // nothing matches - which would look exactly like the preference being lost.
  const oneOfOrNull = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
    (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null);
  return {
    landing: oneOf(j.landing, LANDINGS.map((l) => l.path), LAYOUT_DEFAULT.landing),
    sectionOrder: oneOf(j.sectionOrder, SECTION_ORDERS, LAYOUT_DEFAULT.sectionOrder),
    hiddenPanels: hidden,
    primaryTile: oneOfOrNull(j.primaryTile, QUICK_TILES.map((t) => t.id)),
    primaryCard: oneOfOrNull(j.primaryCard, CONTROL_CARDS.map((c) => c.id)),
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

// ── the Settings nav's folded groups ────────────────────────────────────────
//
// THE DEFAULT IS CLOSED, and that is why this stores neither "the open set" nor
// "the closed set" but an OPINION PER GROUP, with a third state for "no opinion".
//
// SettingBlock's rule is "remember the change, not the default", and it works
// there because the default is a constant: expanded. Here the default is not a
// constant - it is "the group containing the page you are on" - so a plain list
// means the wrong thing in both directions:
//
//   · a list of CLOSED groups makes absence mean open, so a fresh browser opens
//     all six, which is the complaint this exists to answer. And the first fold
//     would implicitly open the other five forever;
//   · a list of OPEN groups cannot record a fold of the group you are standing
//     in - its toggle would be a control that visibly does nothing - and it
//     accumulates: visiting a section would have to write its group in, so a
//     reader who browsed the whole area would end up with everything open again.
//
// With an opinion per group, a reader who never touches a toggle never writes
// anything, and so always sees exactly one group open. `groupOpen()` is the only
// place the default lives.
//
// Values are booleans and nothing else: group ids are checked by the CALLER
// against its own GROUPS list (this module imports nothing, including the
// registry), and an id this build no longer has is inert rather than harmful -
// it names no toggle and draws no row.

export type OpenGroups = Record<string, boolean>;

export function parseOpenGroups(raw: string | null): OpenGroups {
  const j = parseObject(raw);
  if (!j) return {};
  return Object.fromEntries(
    Object.entries(j).filter((e): e is [string, boolean] => e[0] !== '' && typeof e[1] === 'boolean'),
  );
}

/** Open, for one group, on the page you are on. The ONE statement of the rule. */
export function groupOpen(stored: OpenGroups, id: string, active: string | null): boolean {
  const said = stored[id];
  return typeof said === 'boolean' ? said : id === active;
}

/**
 * Press the toggle. An opinion that has become the default is DELETED rather
 * than written, so re-opening the group you folded leaves no trace, and the
 * stored value only ever records a standing disagreement with the default.
 */
export function toggleGroup(stored: OpenGroups, id: string, active: string | null): OpenGroups {
  const want = !groupOpen(stored, id, active);
  const next = { ...stored };
  if (want === (id === active)) delete next[id];
  else next[id] = want;
  return next;
}

/**
 * Arriving at a section clears a fold on ITS group, so a link, a pasted URL or a
 * hit from "Search settings" always lands somewhere the nav can show.
 *
 * Without this, a group folded once would swallow every later arrival into it:
 * the page would change, the breadcrumb would change, and the nav would show no
 * "you are here" at all. Returns the SAME object when there is nothing to clear,
 * so the caller can skip the write.
 *
 * ARRIVAL, not render - the caller is responsible for calling this when the
 * active group CHANGES (a reload counts; it is how you arrive at a bookmark).
 * Called on every render it would undo a fold of the current group in the frame
 * that wrote it, which reads as a toggle that does nothing. So a fold of the
 * group you are standing in is good until you leave and come back, and that is
 * the whole of the rule: the group you arrive in is open.
 */
export function arriveInGroup(stored: OpenGroups, active: string | null): OpenGroups {
  if (active === null || stored[active] !== false) return stored;
  const next = { ...stored };
  delete next[active];
  return next;
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
  { key: LAYOUT_KEY, what: 'Landing page, Overview order, hidden panels and the primary tile', resettable: true },
  { key: DATA_KEY, what: 'Poll interval and default chart range', resettable: true },
  { key: 'bothy-reading-v1', what: 'Reading size in Files', resettable: true },
  { key: 'bothy-collapsed-groups-v1', what: 'Service groups you collapsed', resettable: true },
  { key: 'bothy-control-nav-v1', what: 'Whether the Control menu is collapsed', resettable: true },
  { key: 'bothy-settings-nav-v1', what: 'Settings blocks you expanded', resettable: true },
  { key: SETTINGS_GROUPS_KEY, what: 'Groups of the Settings menu you folded open or shut', resettable: true },
  { key: 'bothy-files-panes-v1', what: 'Pane widths in Files', resettable: true },
  { key: 'bothy-read-recent-v1', what: 'Recently opened documents', resettable: true },
  { key: 'bothy-dev-roles', what: 'Development only: roles to draw as held', resettable: true },
  { key: 'bothy-dev-kube-outcome', what: 'Development only: a forced cluster outcome', resettable: true },
  { key: 'bothy-dev-config-outcome', what: 'Development only: a forced config outcome', resettable: true },
  { key: 'bothy-dev-control-outcome', what: 'Development only: a forced container outcome', resettable: true },
  { key: 'bothy-dev-admin-outcome', what: 'Development only: a forced admin outcome', resettable: true },
];
