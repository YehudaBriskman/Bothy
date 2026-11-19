/**
 * Words for the four sections that follow the four-up features: the clip, the sizes compared,
 * and under the hood. Kept beside en.ts, not inside it, so the open home-page work does not collide with it; fold it
 * into Messages when the second locale arrives. Every figure comes from facts.ts, the example fixtures or the lab
 * record (docs/plans/thin-bothy/bothy-install.md, 10b, 10e, 10f, I8, I14, I20, I21); anything drawn rather than
 * measured says "Example" on its face.
 */
export const ns = {
  example: 'Example',
  views: {
    th: { service: 'Service', state: 'State', module: 'Module', limit: 'Memory limit' },
    installed: 'installed',
    notInstalled: 'not installed',
    core: 'core',
    readOnly: 'Writing: read-only',
    filter: 'Filter services',
    command: 'Command',
  },
  motion: {
    eyebrow: 'In motion',
    heading: 'See it move.',
    lede: 'A short clip of the console at work. Press play.',
    caption: 'Scripted from example data, not a recording of a real machine.',
    play: 'Play the clip',
    pause: 'Pause the clip',
    scrub: 'Clip position',
    chapters: 'Chapters',
    transcript:
      'In the console, the pointer types wiki into the services filter and clicks the wiki row. After a short load its state changes from starting to up. The Files tab opens: the pointer chooses first-run.md in the setup folder and rests on the read-only label. The Health tab shows four tiles; when a service stops, the first tile changes to 4 of 6 up, in amber. On the Modules tab the command bothy module add node-metrics is typed and run, and the module shows as installed.',
    len: 28,
    chapterList: [
      { id: 'services', name: 'Services', t: 0 },
      { id: 'notes', name: 'Notes', t: 7 },
      { id: 'health', name: 'Health', t: 14 },
      { id: 'install', name: 'Install', t: 20 },
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
