/**
 * Words for the four sections that follow the four-up features: the clip, the sizes compared,
 * and under the hood. Kept beside en.ts, not inside it, so the open home-page work does not collide with it; fold it
 * into Messages when the second locale arrives. Every figure comes from facts.ts, the example fixtures or the lab
 * record (docs/plans/thin-bothy/bothy-install.md, 10b, 10e, 10f, I8, I14, I20, I21); anything drawn rather than
 * measured says "Example" on its face.
 */
import { clip, views } from './clip-en.ts';

export const ns = {
  example: 'Example',
  views,
  clip,
  motion: {
    eyebrow: 'In motion',
    heading: 'See it move.',
    lede: 'A short clip of the console at work. Press play.',
    caption:
      'Scripted from example data, not a recording of a real machine. The last chapter, Grafana, is an illustration of a possible add-on, not a shipped module.',
    play: 'Play the clip',
    pause: 'Pause the clip',
    scrub: 'Clip position',
    chapters: 'Chapters',
    speed: 'Playback speed',
    transcript:
      'In the console, the pointer presses Refresh, filters the services by Running and All, types wiki into the search box and clicks the wiki row. A detail drawer opens with the image, ports and uptime; the pointer flips a restart-automatically toggle, ticks a checkbox, presses Restart and confirms in a popup; a toast says Restarted wiki. On the Logs tab lines stream in with times and levels; the pointer opens the level menu and chooses Error, types timeout into the line filter, turns Follow off and back on with Jump to latest, and copies a line. On the Files tab it expands the setup folder, opens first-run.md, searches for ports and opens ports.md. On the Health tab four tiles and a CPU line change as the range goes from 1h to 6h to 24h. On the Modules tab the command bothy module add node-metrics is typed and run, and the module shows as installed. Back in the services list an example Grafana row appears; its Open button opens a second browser tab with an example dashboard of four panels, a hover tooltip and a time picker, then the pointer returns to the Bothy tab. The Grafana step is an illustration: no module installs Grafana today.',
    len: 78,
    chapterList: [
      { id: 'services', name: 'Services', t: 0 },
      { id: 'logs', name: 'Logs', t: 18.5 },
      { id: 'notes', name: 'Notes', t: 39 },
      { id: 'health', name: 'Health', t: 48.5 },
      { id: 'install', name: 'Install', t: 55.5 },
      { id: 'grafana', name: 'Grafana', t: 65.5 },
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
