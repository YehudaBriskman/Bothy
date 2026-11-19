/**
 * Words for the four sections that follow the four-up features: the parts up close, the clips, the sizes compared,
 * and under the hood. Kept beside en.ts, not inside it, so the open home-page work does not collide with it; fold it
 * into Messages when the second locale arrives. Every figure comes from facts.ts, the example fixtures or the lab
 * record (docs/plans/thin-bothy/bothy-install.md, 10b, 10e, 10f, I8, I14, I20, I21); anything drawn rather than
 * measured says "Example" on its face.
 */
export const ns = {
  example: 'Example',
  parts: {
    eyebrow: 'The parts',
    heading: 'Four pieces, up close.',
    lede: 'One screen, four views. Choose one to see it at full size.',
    tabsLabel: 'Choose a view of the console',
    views: [
      { id: 'services', name: 'Services', cap: 'What is running. Found by asking Docker; nothing to register.' },
      { id: 'overview', name: 'Overview', cap: 'Four vitals: services, routes, updates and the last backup.' },
      { id: 'files', name: 'Files', cap: 'Notes where they live. Read-only by design.' },
      { id: 'modules', name: 'Modules', cap: 'What is installed. The limits are the ones declared in the repository.' },
    ],
    th: { service: 'Service', state: 'State', group: 'Group', module: 'Module', limit: 'Memory limit' },
    installed: 'installed',
    notInstalled: 'not installed',
    core: 'core',
    readOnly: 'Writing: read-only',
  },
  motion: {
    eyebrow: 'In motion',
    heading: 'See it move.',
    lede: 'Four short looks at the app, one at a time. Nothing plays until you press play.',
    tabsLabel: 'Choose a clip',
    play: 'Play',
    pause: 'Pause',
    transcript: 'Transcript',
    loop: 'loop',
    note: 'These previews are drawn from example data, not recorded. The recordings of the real app replace them as they are made.',
    clips: [
      {
        id: 'services',
        name: 'Services',
        len: 8,
        cap: 'Bothy asks Docker what is running and lists it. A starting service turns up on its own.',
        script:
          'The Services table shows seven rows: four notes services up, the wiki starting, a dev server unknown and a nightly backup stopped. The pointer moves to the wiki row. Its state changes from starting to up.',
      },
      {
        id: 'files',
        name: 'Notes',
        len: 10,
        cap: 'A reader for the notes kept on the machine. It only reads: the page says so.',
        script:
          'The Files tab shows a tree of example notes. The pointer opens the setup folder, then first-run.md. The page shows as text. A chip on it says Writing: read-only.',
      },
      {
        id: 'health',
        name: 'Health',
        len: 6,
        cap: 'Four vitals on one strip. Stop a service and the strip says so.',
        script:
          'The overview shows four tiles: services 5 of 6 up, routes 3 of 3, one update and the last backup 11 hours ago. A service stops and the first tile changes to 4 of 6 up, in amber.',
      },
      {
        id: 'install',
        name: 'Install',
        len: 12,
        cap: 'Read the plan, then install. Shortened: a real install takes 24 to 39 seconds in our lab.',
        script:
          'In a terminal, bothy install --dry-run prints four checks and stops. Then bothy install runs, shortened, and ends on the line "Bivvy is up" with the address.',
      },
    ],
  },
  compare: {
    eyebrow: 'Four sizes, compared',
    heading: 'What each size is, and what is built.',
    lede: 'Only the smallest installs today, and only it has a measured cost. The rest say so.',
    caption: 'The four sizes compared: what each includes and where it stands',
    pick: 'Highlight a size',
    all: 'All',
    row: 'Row',
    yes: 'Yes',
    no: 'No',
    youPick: 'You pick',
    notMeasured: 'Not yet measured',
    planned: 'Planned, not built',
    cairnPlanned: 'Planned. The building block, `bothy module add`, is tested on a simulated machine only.',
    groups: ['What it includes', 'Where it stands'],
    rows: [
      'The console: services, health, modules',
      'A read-only reader for your notes',
      'Metrics, logs, alerts and backups',
      'Dashboards, single sign-on, a database, a cluster view',
    ],
    installs: 'Installs today',
    memory: 'Memory in our lab, after install',
    gate: 'Free memory the installer wants first',
    memoryCell: (mib: number) => `**${mib} MiB** across three containers`,
    gateCell: (mib: number) => `**${mib} MiB**`,
  },
  hood: {
    eyebrow: 'Under the hood',
    heading: 'One system, from the door down.',
    lede: 'Scroll down it. Each box carries one fact, taken from our lab record or from the repository.',
    trace: 'Highlight',
    note: 'How the console learns what is running from Docker is not drawn: it is not confirmed for the installed size yet.',
    nodes: {
      browser: {
        kicker: 'Where it starts',
        title: 'Your browser',
        fact: 'In our lab record Docker published exactly one port: 80.',
      },
      edge: {
        kicker: 'The one open door',
        title: 'The edge',
        fact: 'File provider only. There is no Docker socket in it: its one bind is a read-only folder of routes.',
      },
      routes: {
        kicker: 'Read by the edge',
        title: 'The routes',
        fact: 'Written ahead of time and checked: exact paths plus one catch-all, no host rules and no dashboard.',
      },
      ping: {
        kicker: 'Inside the edge',
        title: 'A private health port',
        fact: 'It answers inside the edge only: another container is refused.',
      },
      console: {
        kicker: 'Behind the edge',
        title: 'The console',
        fact: 'The web console. It serves the portal page and `/version.json`.',
      },
      files: {
        kicker: 'Behind the edge',
        title: 'The notes reader',
        fact: 'Read-only three times over: the policy, a read-only mount and no write route at all.',
      },
      version: {
        kicker: 'From the console',
        title: 'The version',
        fact: '`/version.json` gives the revision. In the lab it matched the release’s manifest commit.',
      },
      folder: {
        kicker: 'Read by the reader',
        title: 'The notes folder',
        fact: 'Only twelve read routes are exposed. None writes, deletes, downloads an archive or serves a file raw.',
      },
      release: {
        kicker: 'Before anything starts',
        title: 'The release',
        fact: 'Three images, pulled by digest and checked against `checksums.txt`.',
      },
      machine: {
        kicker: 'It all runs here',
        title: 'The machine',
        fact: (gate: number) =>
          `Linux amd64 with Docker and Compose v2. The installer wants ${gate} MiB free: 448 MiB of limits plus a 512 MiB reserve.`,
      },
      data: {
        kicker: 'Kept beside it',
        title: 'Your data',
        fact: 'Uninstall keeps it. Deleting it takes a typed phrase.',
      },
    },
  },
};
