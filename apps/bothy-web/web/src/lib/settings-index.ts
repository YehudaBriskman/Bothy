// The Settings area's map: every section, every block, and the search over them.
//
// ONE registry for three consumers - the left nav, the breadcrumbs and "Search
// settings" - so a block cannot be findable under a title the page no longer
// shows. Each page renders its blocks by id from here (SettingBlock looks its
// title and description up), and checks/settings-index.mjs asserts every id is
// unique, every block's section exists, and the search finds what it should.
//
// IMPORTS NOTHING, so the check can compile it with a bare tsc. Icons are named
// here as strings and resolved to lucide components by the shell.

export type SettingsGroup = 'you' | 'look' | 'data' | 'access' | 'operations' | 'box';

export const GROUPS: readonly { id: SettingsGroup; title: string }[] = [
  { id: 'you', title: 'You' },
  { id: 'look', title: 'Look and feel' },
  { id: 'data', title: 'Data' },
  { id: 'access', title: 'Access' },
  { id: 'operations', title: 'Operations' },
  { id: 'box', title: 'This box' },
];

export interface SettingsSection {
  id: string;
  title: string;
  group: SettingsGroup;
  icon: string;
  /** One line under the page title. */
  lede: string;
  /** The role a page's DATA needs, for the nav's quiet hint. Never a gate - the
   *  edge decides; this only says in advance why a block will say no. */
  needs?: 'viewer' | 'operator';
}

export const SECTIONS: readonly SettingsSection[] = [
  { id: 'profile', title: 'Profile & session', group: 'you', icon: 'user',
    lede: 'Who you are signed in as, what your token lets you do, and where the session comes from.' },
  { id: 'appearance', title: 'Appearance', group: 'look', icon: 'palette',
    lede: 'Theme, type, density, motion and accent. All of it is kept in this browser.' },
  { id: 'layout', title: 'Layout & navigation', group: 'look', icon: 'layout',
    lede: 'Where Bothy opens, how the Overview is arranged, and the layout this browser remembers.' },
  { id: 'data', title: 'Data & refresh', group: 'data', icon: 'refresh',
    lede: 'How often pages ask the box, what charts show first, how long the box keeps history.' },
  { id: 'placement', title: 'Services & placement', group: 'data', icon: 'waypoints',
    lede: 'Where each system is shown on the Overview, from apps/bothy-collector/placement.yml.' },
  { id: 'users', title: 'Users & roles', group: 'access', icon: 'users', needs: 'operator',
    lede: 'Every account in the devbox realm, and which of the four roles it holds.' },
  { id: 'credentials', title: 'Credentials', group: 'access', icon: 'key', needs: 'operator',
    lede: 'Every credential on the box: what it is for, where it lives, how old it is, how to rotate it. Never a value.' },
  { id: 'cluster', title: 'Cluster', group: 'operations', icon: 'ship',
    lede: 'What Bothy may do to the Kubernetes cluster, and the identity it does it with.' },
  { id: 'monitoring', title: 'Monitoring & alerts', group: 'operations', icon: 'activity',
    lede: 'What is scraped, whether it answers, and the alert rules Grafana evaluates.' },
  { id: 'audit', title: 'Audit log', group: 'operations', icon: 'scroll', needs: 'operator',
    lede: 'Every action, file write, config patch and admin read, newest first.' },
  { id: 'backups', title: 'Backups', group: 'box', icon: 'archive', needs: 'operator',
    lede: 'What the nightly backup keeps, how recent it is, and how to take one now.' },
  { id: 'updates', title: 'Updates', group: 'box', icon: 'download',
    lede: 'What is newer than what this box runs, how far each component may update on its own, and how to apply an update by hand.' },
  { id: 'about', title: 'About & health', group: 'box', icon: 'info',
    lede: 'The Bothy containers, their images and health, and where the documentation is.' },
];

export interface SettingsBlockDef {
  id: string;
  section: string;
  title: string;
  description: string;
  /** Extra words a person might search for that the title and description do not use. */
  keywords?: string;
}

export const BLOCKS: readonly SettingsBlockDef[] = [
  // profile
  { id: 'account', section: 'profile', title: 'Your account', description: 'Username, email and the durable subject id, from the session.', keywords: 'identity email username who am i' },
  { id: 'roles', section: 'profile', title: 'What you may do', description: 'The four roles and which of them your token carries.', keywords: 'viewer editor operator shell permissions groups' },
  { id: 'session', section: 'profile', title: 'Session', description: 'Where the session is issued, carried and enforced - and signing out.', keywords: 'sign out logout keycloak oauth2-proxy cookie password change' },
  // appearance
  { id: 'theme', section: 'appearance', title: 'Theme', description: 'Dark, light, system, or one of the named palettes.', keywords: 'dark mode light mode colour color palette' },
  { id: 'make-theme', section: 'appearance', title: 'Make your own theme', description: 'The live theme editor, or a .css file on the box.', keywords: 'custom theme editor css' },
  { id: 'reading', section: 'appearance', title: 'Reading size', description: 'The type size of documents and their side panels in Files.', keywords: 'font size text size zoom' },
  { id: 'doc-font', section: 'appearance', title: 'Document font', description: 'Sans or serif for rendered documents in Files.', keywords: 'typeface serif sans font family' },
  { id: 'density', section: 'appearance', title: 'Table density', description: 'Comfortable or compact rows in every table.', keywords: 'compact spacing rows padding' },
  { id: 'motion', section: 'appearance', title: 'Motion', description: 'Follow the system, or turn transitions and animations off here.', keywords: 'reduced motion animation accessibility' },
  { id: 'accent', section: 'appearance', title: 'Accent', description: 'The interactive colour on Bothy Dark and Bothy Light.', keywords: 'colour color highlight links focus' },
  // layout
  { id: 'landing', section: 'layout', title: 'Landing page', description: 'The page a bare visit to Bothy opens on.', keywords: 'home start default page' },
  { id: 'overview-order', section: 'layout', title: 'Overview section order', description: 'Bothy first or Projects first in the system matrix.', keywords: 'sort order sections projects' },
  { id: 'overview-panels', section: 'layout', title: 'Overview panels', description: 'Which optional panels the Overview shows.', keywords: 'hide show widgets cards vitals disk' },
  { id: 'remembered-layout', section: 'layout', title: 'Remembered layout', description: 'Collapsed groups, the Control menu and pane widths - see and reset them.', keywords: 'reset collapsed groups sidebar panes' },
  // data
  { id: 'poll', section: 'data', title: 'Refresh interval', description: 'How often the pages ask Docker and Traefik for the state of the box.', keywords: 'poll polling refresh rate interval seconds' },
  { id: 'chart-range', section: 'data', title: 'Default chart range', description: 'The time range the vitals charts open on.', keywords: 'metrics time range graphs 1h 24h' },
  { id: 'retention', section: 'data', title: 'Retention', description: 'How long VictoriaMetrics and Loki keep history, read from their config files.', keywords: 'metrics logs history days storage victoriametrics loki' },
  { id: 'local-data', section: 'data', title: 'Data in this browser', description: 'Every key Bothy keeps in this browser, and clearing them.', keywords: 'localstorage cache clear reset storage' },
  // placement
  { id: 'placement-rules', section: 'placement', title: 'Placement rules', description: 'Each rule: what it matches, and the section, subgroup, title and group it sets.', keywords: 'placement.yml grouping sections subgroup overview' },
  { id: 'placement-edit', section: 'placement', title: 'Changing a rule', description: 'Where placement is edited, and who may.', keywords: 'edit placement editor role' },
  // users
  { id: 'user-list', section: 'users', title: 'Users', description: 'Accounts in the devbox realm with their roles, password age and sessions.', keywords: 'accounts keycloak members people' },
  { id: 'role-ladder', section: 'users', title: 'Roles', description: 'What each of the four roles gates at the edge.', keywords: 'viewer editor operator shell permissions' },
  { id: 'user-changes', section: 'users', title: 'Changing users and roles', description: 'Where accounts, roles and passwords are changed today.', keywords: 'add user grant role reset password keycloak console' },
  // credentials
  { id: 'env-keys', section: 'credentials', title: 'Keys in .env', description: 'Every credential key, whether it is set, what reads it and how to rotate it.', keywords: 'passwords secrets environment variables rotate' },
  { id: 'credential-files', section: 'credentials', title: 'Credential files', description: 'Tokens and generated secrets on disk, with their modes and ages.', keywords: 'token kubeconfig file mode permissions rotate' },
  { id: 'keycloak-clients', section: 'credentials', title: 'Keycloak clients', description: 'Clients with a secret, and where that secret lives on this box.', keywords: 'oauth client secret keycloak' },
  // cluster
  { id: 'cluster-scope', section: 'cluster', title: 'Namespaces Bothy may act in', description: 'The literal scope of the cluster verbs.', keywords: 'kubernetes namespaces scope thales' },
  { id: 'cluster-identity', section: 'cluster', title: 'Cluster identity', description: 'The ServiceAccount token bothy-ops uses, and its age.', keywords: 'token serviceaccount rbac can-i kube-token' },
  { id: 'headlamp', section: 'cluster', title: 'Headlamp', description: 'The read-only cluster console, and whether it is running.', keywords: 'kubernetes console dashboard' },
  // monitoring
  { id: 'targets', section: 'monitoring', title: 'Scrape targets', description: 'Every target VictoriaMetrics scrapes, and whether it answered.', keywords: 'prometheus up targets jobs exporters' },
  { id: 'alert-rules', section: 'monitoring', title: 'Alert rules', description: 'The rules Grafana evaluates, from the provisioning file.', keywords: 'alerts alerting grafana notifications' },
  // audit
  { id: 'audit-log', section: 'audit', title: 'Audit log', description: 'Filter by log, person, outcome and action.', keywords: 'history who did what actions writes patches' },
  // backups
  { id: 'backup-sets', section: 'backups', title: 'Backup sets', description: 'Each set: how many copies, the newest, the oldest and the total size.', keywords: 'postgres grafana env dump restore victoriametrics loki alloy audit trash notes' },
  { id: 'backup-schedule', section: 'backups', title: 'Schedule and taking one now', description: 'The nightly timer, and the command.', keywords: 'timer cron nightly just backup' },
  // updates
  { id: 'update-components', section: 'updates', title: 'Components', description: 'Every component: pinned, running and available version, how big the step is, and its channel.', keywords: 'versions upgrade outdated newer release patch minor major drift changelog images pins' },
  { id: 'update-channels', section: 'updates', title: 'Channels and the night window', description: 'What auto, notify and manual mean, and when an automatic update may run.', keywords: 'auto automatic policy window nightly schedule one-way' },
  { id: 'update-apply', section: 'updates', title: 'Applying an update', description: 'Not built yet - the commands that apply one by hand, and how discovery runs.', keywords: 'upgrade apply just recipe manual pull timer discover refresh' },
  // about
  { id: 'containers', section: 'about', title: 'Bothy containers', description: 'The five Bothy containers: image, state and health.', keywords: 'version images health status' },
  { id: 'edge', section: 'about', title: 'Edge', description: 'The Traefik version and its router table.', keywords: 'traefik routers version' },
  { id: 'docs', section: 'about', title: 'Documentation', description: 'The guide, the security model and the design system.', keywords: 'help manual docs security design' },
];

export const sectionById = (id: string): SettingsSection | undefined => SECTIONS.find((s) => s.id === id);
export const blockById = (id: string): SettingsBlockDef | undefined => BLOCKS.find((b) => b.id === id);
export const blocksOf = (section: string): SettingsBlockDef[] => BLOCKS.filter((b) => b.section === section);
export const groupTitle = (g: SettingsGroup): string => GROUPS.find((x) => x.id === g)?.title ?? g;

export interface SettingsHit {
  section: SettingsSection;
  block: SettingsBlockDef | null;
  score: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.@/ -]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Every section and block matching ALL words of the query, best first.
 *
 * A word in a title counts more than one in a description, and a word that
 * starts a title word more than one buried in it - so "pass" puts "Keys in .env"
 * (description: passwords) below nothing, and "theme" puts Theme above Make your
 * own theme. Sections match on their title and lede, so a search for "backup"
 * offers the page as well as its blocks.
 */
export function searchSettings(query: string, limit = 12): SettingsHit[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const score = (title: string, rest: string): number => {
    const t = norm(title);
    const r = norm(rest);
    let total = 0;
    for (const w of words) {
      if (t.split(' ').some((x) => x.startsWith(w))) total += 10;
      else if (t.includes(w)) total += 6;
      else if (r.split(' ').some((x) => x.startsWith(w))) total += 3;
      else if (r.includes(w)) total += 1;
      else return 0;
    }
    // A title that IS the query, or starts with it, outranks one that merely
    // contains the word: "theme" finds Theme before Make your own theme.
    const q = words.join(' ');
    if (t === q) total += 8;
    else if (t.startsWith(q)) total += 4;
    return total;
  };
  const hits: SettingsHit[] = [];
  for (const s of SECTIONS) {
    const sc = score(s.title, `${s.lede} ${groupTitle(s.group)}`);
    if (sc) hits.push({ section: s, block: null, score: sc + 1 });
  }
  for (const b of BLOCKS) {
    const s = sectionById(b.section);
    if (!s) continue;
    const sc = score(b.title, `${b.description} ${b.keywords ?? ''} ${s.title}`);
    if (sc) hits.push({ section: s, block: b, score: sc });
  }
  return hits.sort((a, b) => b.score - a.score
    || (a.block ? 1 : 0) - (b.block ? 1 : 0)
    || (a.block?.title ?? a.section.title).localeCompare(b.block?.title ?? b.section.title)).slice(0, limit);
}

/** The URL for a hit. A block is addressed by `?block=`, which the page expands
 *  and scrolls to - a query rather than a fragment, because under HashRouter the
 *  fragment already IS the route. */
export function hitPath(h: { section: { id: string }; block: { id: string } | null }): string {
  return `/settings/${h.section.id}${h.block ? `?block=${encodeURIComponent(h.block.id)}` : ''}`;
}
