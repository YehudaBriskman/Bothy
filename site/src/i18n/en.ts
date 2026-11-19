/**
 * Every word the site's own pages say, in English.
 *
 * Adding Hebrew is a second file of this exact shape (`he.ts`, typed as
 * `Messages`), one line in `locales.ts` and one entry in ENABLED_LOCALES. No
 * component holds a user-visible string of its own, so there is nothing to hunt
 * for. Two conventions keep translations honest:
 *
 *   - `code` inside backticks is a literal (a command, a file, a version). It is
 *     rendered left-to-right and marked `translate="no"` whatever the page
 *     direction is, so a Hebrew sentence can hold an English command safely.
 *   - `**bold**` is the only other inline markup.
 *
 * Plurals and numbers go through `Intl` in the components, never through string
 * concatenation here; anything with a count is a function.
 *
 * What is NOT here: the Markdown documentation, which is the repository's own
 * English text rendered as it is (see docs/README in the site, and the notice
 * `docs.notTranslated` below).
 */

import type { ModeId, ProvenId, UnprovenId } from '../facts.ts';

export const en = {
  meta: {
    siteTitle: 'Bothy',
    tagline: 'A small console for the machine you run things on',
    description:
      'Bothy is a self-hosted console for one machine. Install it from a single download, the way you install an app. This site shows what works today, and says what does not yet.',
  },

  nav: {
    label: 'Main',
    home: 'Home',
    install: 'Install',
    docs: 'Docs',
    changelog: 'Releases',
    skip: 'Skip to content',
    github: 'Source on GitHub',
    githubShort: 'GitHub',
    getBothy: 'Install',
    moreWays: 'Install options',
    modes: 'Modes',
    about: 'About',
    menuButton: 'Menu',
    menu: {
      label: 'Tested in our lab',
      available: [
        {
          title: 'Linux, amd64',
          sub: 'The release binary, run end to end',
          tag: 'Tested',
          ok: true,
          icon: 'linux',
          to: 'install/#binary',
        },
        {
          title: 'Docker with Compose v2',
          sub: 'What the stack runs on; the installer checks it',
          tag: 'Needed',
          ok: false,
          icon: 'docker',
          to: 'install/#need-h',
        },
      ] as { title: string; sub: string; tag: string; ok: boolean; icon: 'linux' | 'docker'; to: string }[],
      cmdLabel: 'After the download, one command',
      cmd: 'bothy install --dry-run',
      notYet: 'Not yet: macOS, Windows and Linux on arm64 are not built or tested as a place to run it.',
      guide: 'Installing guide',
      builds: 'All builds on GitHub',
      notes: 'Release notes',
    },
  },

  footer: {
    line: 'Bothy is open source. This site is built from the same repository as the software.',
    description: 'A small console for the machine you run things on. Free and open source.',
    version: (v: string) => `Newest release: ${v}`,
    build: 'No scripts from other sites, no analytics, no cookies.',
    source: 'Source',
    releases: 'Releases on GitHub',
    security: 'Security policy',
    github: 'Bothy on GitHub',
    releasesIcon: 'Releases',
    copyright: (year: string) => `© ${year} Yehuda Briskman. Released under the MIT licence.`,
    cols: {
      product: 'Product',
      resources: 'Resources',
      legal: 'Legal',
    },
    links: {
      install: 'Install',
      modes: 'Modes',
      releases: 'Releases',
      about: 'About',
      docs: 'Documentation',
      installing: 'Installing guide',
      source: 'Source code',
      record: 'Test record',
      licence: 'Licence (MIT)',
      security: 'Security policy',
      privacy: 'Privacy',
      accessibility: 'Accessibility',
    },
  },

  cta: {
    heading: 'Give your machine a shelter.',
    soft: 'Free, open, and plain about it.',
    primary: 'Install Bothy',
    secondary: 'Read the docs',
    fine: 'Tested in our lab on Linux amd64 with Docker and Compose. Bivvy, the smallest size, is the one that installs today; everything else is listed as not shown.',
  },

  home: {
    title: 'BothyBox: a free shelter in the hills, for your machine',
    chapterNav: 'The story, chapter by chapter',
    chapterNames: [
      'The sky',
      'What a bothy is',
      'One console',
      'What is inside',
      'Four sizes',
      'Install',
      'Leave it as you found it',
    ],
    hero: {
      heading: 'BothyBox',
      line: 'A free shelter in the hills, for your machine.',
      lede: 'A bothy is an unlocked mountain hut that anyone may use, kept up by the people who use it. Bothy is software with the same manners: one console for the machine you run things on, free and open source.',
      primary: 'Install Bothy',
      secondary: 'Read the docs',
      skipInstall: 'Skip to install',
      skipDescent: 'Skip the descent',
      badge: 'Installs on Linux with Docker',
      sub: 'One console for the machine you run things on. Free and open source.',
      cue: 'Read the story',
      footnote:
        'The sky behind this page follows the hour on your device’s clock, and nothing about it leaves your browser; with no script it is a still picture chosen by your light or dark setting. This page makes no request to another site and sets no cookie.',
      copy: 'Copy',
      copied: 'Copied',
    },
    sky: {
      group: 'Sky controls',
      hour: 'Hour of the day',
      now: 'Now',
      pause: 'Pause motion',
      play: 'Play motion',
    },
    descent: {
      heading: 'What a bothy is',
      lead: 'In the hills of Scotland, and of northern England and Wales, a bothy is a basic shelter: four walls and a roof, no charge and nobody at the door. Volunteers keep them up.',
      codeLabel: 'The Bothy Code, in short',
      code: [
        'Leave it as you found it.',
        'Respect other users and the place.',
        'Keep numbers down.',
        'Turn no one away.',
      ],
      codeSource: 'From the Mountain Bothies Association’s Bothy Code, shortened.',
      close: 'The software borrows the name and the manners. What it does is the next chapter.',
    },
    hut: {
      heading: 'One console for one machine',
      lead: 'Bothy is a web console for a single machine. It finds what is running by asking Docker, shows it on one page, and gives you a reader for the files and notes kept on that machine. It is open source, under the MIT licence.',
      promise: 'It does not replace your tools. It shows and looks after what you already run.',
      guide: 'Read the guide',
    },
    flow: {
      label: 'The console, step by step',
      skip: 'Skip the demo',
    },
    inside: {
      heading: 'What is inside',
      lead: 'These are the parts the guide documents today. Each card links to the page that describes it.',
      items: [
        {
          title: 'Overview',
          body: 'The machine at a glance: a status line of what is up, unknown and stopped against the number expected, then a card for each system. Everything on it is discovered by asking Docker.',
          page: 'the-console',
          link: 'Operating it from the console',
        },
        {
          title: 'Files',
          body: 'Every document on the machine, read straight from the disk it lives on. The reader never writes; editing is a separate page.',
          page: 'files',
          link: 'Bothy Files',
        },
        {
          title: 'Roles',
          body: 'Four roles: `viewer`, `editor`, `operator` and `shell`. Holding one never implies another, and `shell` is defined but granted to nobody.',
          page: 'roles',
          link: 'Roles',
        },
        {
          title: 'Themes',
          body: 'Five themes ship with it. A theme you add is one CSS file in one directory: no rebuild and no restart.',
          page: 'themes',
          link: 'Themes',
        },
      ],
      note: 'The guide describes the console as the repository builds it, which is larger than the Bivvy size that installs today. The next chapter lists the sizes.',
      statsLabel: 'In numbers',
      stats: [
        { unit: 'MiB', label: 'memory used by Bivvy’s three containers, in our lab' },
        { unit: 'MiB', label: 'free memory the installer wants before it starts' },
        { unit: '', label: 'roles: viewer, editor, operator and shell' },
        { unit: '', label: 'themes ship with it' },
      ],
    },
    sizes: {
      heading: 'Four sizes',
      lead: 'Named for the shelters walkers use, smallest first. Only the smallest installs today.',
      now: 'Installable now',
      planned: 'Planned, not built',
      cost: 'Cost',
      pickLabel: 'Pick a size',
      notMeasured: 'Not yet measured.',
      bivvyCost: (usedMiB: number, gateMiB: number) =>
        `Measured in our lab after a stock install: about ${usedMiB} MiB of memory across its three containers. The installer wants ${gateMiB} MiB free before it starts.`,
      items: {
        bivvy: {
          name: 'Bivvy',
          tagline: 'a roof, a door, a lock',
          body: 'The console, a read-only file reader and the edge that serves them. Runs on Docker Compose.',
          note: '',
        },
        bothy: {
          name: 'Bothy',
          tagline: 'four walls and a fire',
          body: 'Bivvy plus metrics, logs, alerts and backups.',
          note: '',
        },
        basecamp: {
          name: 'Basecamp',
          tagline: 'everything before the climb',
          body: 'Bothy plus dashboards, single sign-on, a database and a cluster view.',
          note: '',
        },
        cairn: {
          name: 'Cairn',
          tagline: 'stack your own stones',
          body: 'Pick modules one at a time.',
          note: 'The building block exists: `bothy module add` adds one module to an installed Bivvy. It has been tested against a simulated machine only, and no published release carries a module yet, so Cairn stays planned.',
        },
      } as Record<ModeId, { name: string; tagline: string; body: string; note: string }>,
    },
    install: {
      heading: 'Install with one command',
      lead: 'Once you have the `bothy` file, `bothy install` is the whole job. These are the four commands, in order.',
      terminalLabel: 'The whole install, as typed',
      steps: ['Download the archive.', 'Put it on your path.', 'Read the plan.', 'Install.'],
      stepsLabel: 'The four steps',
      termOut: [
        'saved the archive',
        'bothy is on your path',
        'plan printed, nothing changed',
        'Printed the address. Open it in a browser.',
      ],
      termExample: 'Example output',
      proofLink: 'What has been shown, and what has not',
      terminalNote: 'Run it as your own user, without `sudo`. Run with `sudo` it refuses and changes nothing.',
      checksHeading: 'What it checks before it changes anything',
      checks: {
        docker: 'Docker is present and answering, with the Compose v2 plugin.',
        memory: (gateMiB: number) => `Free memory against the gate: ${gateMiB} MiB must be available.`,
        port: 'The port (80 unless you pass `--port`) is free. If something holds it, nothing is stopped and the message names it.',
        release: 'The release is found, from the binary’s own version.',
        sha: 'The sha256 checks pass: the manifest against `checksums.txt`, and each image by digest.',
        attestation:
          'The build attestation is verified when `gh` is present. When it is not, the install says it skipped that check and prints the exact command to run: `gh attestation verify checksums.txt --repo YehudaBriskman/Bothy`.',
      },
      didHeading: 'What it did',
      did: [
        'Pulled three images by digest: the console, the file reader and the edge.',
        'Started them, then read the bytes the edge actually serves, so another page answering 200 cannot pass.',
        'Printed the address. Open it in a browser.',
      ],
      leaveHeading: 'Leaving',
      leave:
        '`bothy uninstall` removes what the install made and keeps your data and secrets. `bothy uninstall --purge` deletes them too, after you type a confirmation.',
      tested: 'Tested on Linux amd64 with Docker.',
      timing: (min: string, max: string, rerun: string, v: string, date: string) =>
        `In our lab, on a clean machine with only Docker, a stock install of release ${v} took ${min} to ${max} seconds (two runs, ${date}), and running it again took about ${rerun} second. That is what we measured, not a promise; your network decides how long the pulls take.`,
      paths: 'Two ways in: the release binary above, or a source checkout.',
      pathsLink: 'Install page',
      pathsGuide: 'Installing guide',
    },
    proof: {
      heading: 'What has been shown, and what has not',
      shownHeading: 'Shown to work in our lab',
      notHeading: 'Not shown, so not promised',
      shownInstall: (v: string, os: string) =>
        `A stock install of release ${v} on a clean ${os} virtual machine (linux/amd64) with only Docker and Compose: the page and the file reader answered with the right bytes.`,
      shown: {
        install: '',
        checksum:
          'The release is checked against its own `checksums.txt` and every image is pulled by digest, before anything is changed.',
        'attestation-skip':
          'Without the GitHub CLI the attestation check is skipped and the exact command to run is printed. With `--require-attestation` the install refuses instead.',
        rerun: 'Running the install again changed nothing.',
        tamper:
          'A tampered release, a mismatched version and two forced failures were each refused or rolled back to the previous state, byte for byte.',
        uninstall:
          '`bothy uninstall` and `bothy uninstall --purge` removed what they should; your data and secrets stay unless you purge.',
        preflight:
          'A taken port, a stopped Docker, a missing Compose plugin, too little memory and a read-only home were each refused with the fix named and nothing created.',
      } as Record<Exclude<ProvenId, 'install'>, string>,
      not: {
        arm64: 'Running on `arm64`: the images can be pulled, and nobody has run them.',
        wsl: 'WSL, including Docker Desktop for WSL.',
        rootless: 'Rootless Docker: refused by design, never run on a real one.',
        'mini-host': 'A machine with 2 GiB of memory.',
        'update-real': 'A real update or downgrade between two real releases.',
        'attestation-guest': 'A verified attestation inside a fresh machine: it was verified on the host only.',
        selinux: 'SELinux enforcing: the installer warns and prints the command; the denial itself was not reproduced.',
        ipv6: 'IPv6-only networks.',
        'desktop-hosts':
          'macOS and Windows machines: those archives are command-line clients, not a place to run the stack.',
        k3s: 'k3s: a design, not what installs today.',
        'modules-real': 'Adding a module to a real release: tested against a simulated machine only.',
      } as Record<UnprovenId, string>,
      asOf: (release: string) => `Written against release ${release}.`,
      where: 'The full record is in the repository.',
      whereLink: 'Install notes and test results',
    },
    trust: {
      heading: 'Leave it as you found it',
      lead: 'Each line here can be checked.',
      claims: [
        'Releases carry sha256 checksums and a build attestation.',
        'The installer verifies before it changes anything, and rolls back when something fails.',
        '`bothy uninstall` removes what the install added.',
        'This site runs no analytics, sets no cookie and loads nothing from another site.',
      ],
      linksLabel: 'Where to check',
      links: {
        source: { name: 'Source', note: 'All of it, in one repository.' },
        licence: { name: 'Licence', note: 'MIT.' },
        releases: { name: 'Releases', note: 'Binaries, checksums and attestations.' },
        security: { name: 'Security policy', note: 'What is protected, and how to report a problem.' },
      },
      close: 'Leave it as you found it. Turn no one away.',
      bandText: 'Read the plan before anything changes.',
    },
  },

  after: {
    eyebrow: 'What you get',
    heading: 'A small console, kept honest.',
    lede: 'This is what Bivvy, the size that installs today, gives you. The panels inside the pictures are examples, not your machine.',
    example: 'Example',
    overview: {
      title: 'One page for the machine',
      lead: '**See what is running.** Bothy asks Docker what is up and shows it on one page, with nothing to register by hand.',
      panel: 'Overview',
      rows: [
        { name: 'edge', sub: 'serves the pages' },
        { name: 'console', sub: 'the web console' },
        { name: 'files', sub: 'the notes reader' },
      ],
      state: 'up',
      foot: 'Bivvy’s three containers, as they would appear.',
      link: 'The console',
    },
    files: {
      title: 'Notes where they live',
      lead: '**Read what is on the disk.** A reader for the documents kept on the machine, straight from where they are. It never writes.',
      panel: 'Files',
      rows: ['README.md', 'runbook.md', 'ports.md'],
      readOnly: 'Writing',
      foot: 'The reader is read-only by design.',
      link: 'Bothy Files',
    },
    checks: {
      title: 'It checks before it changes anything',
      lead: '**Read the plan first.** `bothy install --dry-run` prints the plan and every preflight result, and changes nothing. If one fails, it stops with the fix named.',
      panel: 'Dry run',
      rows: (gateMiB: number) => [
        'Docker answers, Compose v2 present',
        `At least ${gateMiB} MiB of memory free`,
        'Port 80 is free',
        'sha256 matches checksums.txt',
      ],
      foot: 'The checks are real; the ticks are an example.',
      short: ['docker', 'memory', 'port 80', 'sha256'],
      done: 'nothing changed',
      link: 'What the install checks',
    },
    aboutSecond: (n: string) => `about ${n} s`,
    features: [
      {
        icon: 'shield',
        big: 'sha256',
        lead: '**Verified releases.**',
        rest: 'Checked against their own checksums, every image pulled by digest.',
      },
      { icon: 'repeat', big: '', lead: '**Safe to run twice.**', rest: 'In our lab a second install changed nothing.' },
      {
        icon: 'stop',
        big: 'Refused',
        lead: '**Refuses with the fix.**',
        rest: 'A taken port, a stopped Docker or too little memory: nothing is created and the message says why.',
      },
      {
        icon: 'leave',
        big: 'Undone',
        lead: '**Leaves as found.**',
        rest: '`bothy uninstall` removes what it added and keeps your data unless you purge.',
      },
    ],
  },

  about: {
    title: 'About Bothy',
    description:
      'Where the name comes from, what Bothy is, how it is made and what this site does with your visit: nothing.',
    eyebrow: 'About',
    heading: 'A shelter, kept by the people who use it.',
    nameEyebrow: 'The name',
    whatEyebrow: 'The software',
    madeEyebrow: 'How it is made',
    privacyEyebrow: 'This site',
    privacyHeading: 'Nothing about your visit leaves your browser.',
    privacyBody:
      'The sky on the home page follows the hour on your device’s clock, worked out in your browser; with no script it is a still picture chosen by your light or dark setting. No page here makes a request to another site or sets a cookie.',
  },

  install: {
    title: 'Install Bothy',
    description:
      'Two ways to install Bothy: the bothy binary from a release, with its checksums and attestation commands, or a source checkout. What was tested, what was not, how to uninstall.',
    eyebrow: 'Linux amd64 with Docker',
    heading: 'Install Bothy',
    lede: 'Two ways in. The release binary is the one that has been tested end to end: Linux amd64 with Docker. Run everything below as your normal user.',
    release: {
      latest: (v: string, date: string) => `Newest release: ${v}, published ${date}.`,
      proven: (v: string) => `The lab proof ran release ${v}.`,
      newer: (proven: string) =>
        `This is newer than release ${proven}, the one the install proof last ran against. It is built by the same pipeline; it has not been proven separately.`,
      page: 'Release page',
    },
    paths: {
      heading: 'Pick a path',
      jump: 'Go to the steps',
      binary: {
        title: 'The release binary',
        tag: 'Tested in our lab',
        body: 'Download `bothy`, verify it, run `bothy install`. No clone, no build. It starts the small stack, Bivvy: three containers, the console and a read-only notes reader behind one edge.',
        needs: 'Needs: Linux amd64, Docker with the Compose v2 plugin, a user who can run `docker` without `sudo`.',
        proof:
          'Shown: a stock install of this kind on a clean Linux amd64 machine with only Docker and Compose (see the lists below).',
      },
      source: {
        title: 'A source checkout',
        tag: 'The development stack',
        body: 'Clone the repository and run its own `just` recipes. This starts the full development stack, about twenty containers with dashboards, single sign-on and a database, not the small one.',
        needs: 'Needs: Docker with Compose v2, git, curl, python3, openssl, and `just`.',
        proof:
          'Shown: the repository’s install workflow runs this path on every pull request. The installing guide says the same and is the reference.',
      },
    },
    need: {
      heading: 'Requirements',
      lead: 'For `bothy install`. The installer checks each one before it changes anything, and stops with the fix named.',
      memory: (gateMiB: number) =>
        `**Memory:** at least ${gateMiB} MiB available. Below that the install refuses before it changes anything and prints the figures.`,
      items: [
        '**Linux, amd64.** Other systems are listed under “Not shown” below.',
        '**Docker** (Engine 25 or newer) with the **Compose v2** plugin, answering to your user without `sudo`. If your user is not in the `docker` group the installer says so and prints the `usermod` fix.',
        '**Disk:** about 2 GiB free where it installs (under `~/.local/share/bothy` by default).',
        '**Port 80 free**, or pass `--port`. If something holds it, nothing is stopped and the message names what does.',
      ],
    },
    user: {
      heading: 'Run it as your normal user',
      body: 'Do not use `sudo` and do not log in as root: `bothy install`, `update` and `uninstall` are built to refuse both, change nothing, and tell you to run as your own user. An install made as root would leave root-owned files in your tree that you could not later update or remove.',
      caveat:
        'That refusal is covered by the installer’s unit tests; it has not been tried on a lab machine. The way to stay clear of it is simply to run as yourself.',
    },
    binary: {
      heading: 'Path 1: the release binary',
      steps: {
        download: {
          title: 'Download the archive and the checksums',
          body: 'Both are release assets. The archive holds one file, `bothy`.',
        },
        verify: {
          title: 'Verify what you downloaded',
          body: 'The first command checks the archive against the release’s `checksums.txt`. The second checks that GitHub attested the build and ties the file to this repository; it needs the `gh` command and is optional. The installer repeats these checks on the release it installs.',
          expect: 'The checksum the release feed lists for this archive:',
          expectNote: 'It should match the line for this archive in `checksums.txt`.',
          noSha: 'The release feed has no checksum for this archive. Use `checksums.txt` from the release.',
        },
        place: {
          title: 'Put it on your path',
          body: 'Any directory on your `PATH` will do. `~/.local/bin` needs no root.',
        },
        install: {
          title: 'Read the plan, then install',
          body: 'The dry run prints the plan and the preflight results and changes nothing. The real run prints the address when it is up. It listens on `127.0.0.1` unless you pass `--bind`.',
          after:
            'It prints `Bivvy is up` with the address. Open it in a browser on the same machine. Running it again is safe: finished steps are skipped and an interrupted run resumes.',
          bind: 'Think before `--bind 0.0.0.0`: the console’s first login is plain HTTP and the notes reader has no login, so anyone who can reach the port can read the notes folder. Do that only on a network you trust.',
        },
      },
    },
    source: {
      heading: 'Path 2: a source checkout',
      lead: 'The commands are the ones in the installing guide, which is the reference for this path. It needs more on the machine and starts far more containers.',
      stepsTitle: 'Clone and start',
      notes: [
        'Nothing in `.env` needs filling in: the five credentials are generated for you, never printed, and never overwritten.',
        'To check the prerequisites first: `bothy doctor --pre`. The section “Before anything” of the guide lists them.',
        'This is the development stack. It is not the small install above, and `bothy install` does not manage it.',
      ],
      guide: 'Read the installing guide',
    },
    later: {
      heading: 'Updating and uninstalling',
      items: [
        '`bothy update --check` prints what an update would change and changes nothing. `bothy update` is built to verify the new release as the install does, keep the previous one, and restore it if the new one does not come up healthy.',
        '**What was tested:** `update` refused a tampered or mismatched release and restored the previous state byte for byte. **What was not:** a real update between two real releases. It is on the “Not shown” list.',
        '`bothy uninstall` prints its plan (add `--dry-run` to stop there), then stops the stack and removes what it generated. Your data, your secrets and the pulled images stay.',
        '`bothy uninstall --purge` also deletes your data, secrets, the images and the install root, but only after you type `delete bothy data`. A wrong answer deletes nothing.',
        'For the source checkout: `just down` stops it, and `just nuke` deletes every data volume after asking. Both are in the installing guide.',
      ],
    },
    platforms: {
      heading: 'Which archive',
      intro: 'Every release carries these. Only the first row is shown to run a stack.',
      columns: { system: 'System', archive: 'Archive', status: 'Status', size: 'Size', sha: 'SHA-256' },
      rows: {
        'linux/amd64': 'Run end to end in the lab',
        'linux/arm64': 'Built, never run',
        'darwin/amd64': 'Command-line client only',
        'darwin/arm64': 'Command-line client only',
        'windows/amd64': 'Command-line client only',
        'windows/arm64': 'Command-line client only',
      } as Record<string, string>,
      noFeed: 'The release list for this build has no assets to show.',
    },
    notSupported: {
      heading: 'Not offered yet',
      items: [
        'The larger sizes (Bothy, Basecamp, Cairn) cannot be installed yet. Only Bivvy installs.',
        'A system-wide install for a headless server. The install is per user.',
        'A package for apt, dnf, Homebrew or winget.',
      ],
    },
    proof: {
      heading: 'What has been shown, and what has not',
      lead: 'The same two lists as on the home page, taken from the repository’s test record. Nothing on this page promises anything in the second list.',
    },
    older: {
      heading: 'More',
      body: 'The documentation describes the full stack from a source checkout.',
      link: 'The installing guide',
      record: 'Install notes and test results',
    },
  },

  docs: {
    title: 'Documentation',
    description: 'The Bothy guide, rendered from the Markdown in the repository.',
    eyebrow: 'The guide',
    heading: 'Documentation',
    lede: 'These pages are the repository’s own guide, rendered from the same Markdown files. Where a page links to a file that is not part of the guide, the link goes to the source on GitHub.',
    notTranslated: 'The documentation is English only.',
    stackNote:
      'These pages describe the full development stack, run from a source checkout. The small install, `bothy install`, is on the Install page.',
    installLink: 'Install page',
    checkoutBanner: {
      title: 'This page describes the source-checkout path',
      body: 'It covers the full development stack, started from a clone of the repository. To install the small stack from a release binary, use `bothy install` instead.',
      link: 'Install with bothy install',
    },
    breadcrumb: 'Documentation',
    groups: {
      start: 'Getting it running',
      use: 'Using it',
      operate: 'Operating it',
    },
    search: {
      label: 'Search the documentation',
      placeholder: 'Search the docs…',
      none: (q: string) => `Nothing in the docs matches “${q}”.`,
      results: (n: number) => (n === 1 ? '1 result' : `${n} results`),
      needsScript: 'Search needs JavaScript. The list below is the whole guide.',
    },
    onThisPage: 'On this page',
    sourceLink: 'Source of this page',
    prev: 'Previous',
    next: 'Next',
    unlinked: 'This reference is not part of the public documentation.',
    sidebarLabel: 'Documentation pages',
    tableLabel: 'Table',
    pagerLabel: 'Previous and next page',
  },

  changelog: {
    title: 'Releases',
    description: 'Every Bothy release, from the repository’s release notes.',
    eyebrow: 'Changelog',
    heading: 'Releases',
    lede: 'Built from the repository’s GitHub release notes when this site was built. A version listed here has a release page and files you can download.',
    builtFrom: (generated: string) => `Release data captured ${generated}.`,
    changes: 'What changed',
    noChanges: 'No change list was published for this release.',
    assets: 'Files',
    images: (n: number) => (n === 1 ? '1 image, pinned by digest' : `${n} images, pinned by digest`),
    commit: 'Commit',
    fullDiff: 'Full comparison on GitHub',
    releasePage: 'Release page',
    latest: 'Newest',
    empty: 'No releases were found.',
  },

  notFound: {
    title: 'Page not found',
    heading: 'No page here',
    body: 'That address is not part of this site. It may have moved, or it may never have existed.',
    links: 'Try one of these',
  },

  accessibility: {
    title: 'Accessibility',
    description:
      'What this site aims for (WCAG 2.2 AA), what was tested and how, the limits we know of, and how to report a barrier.',
    eyebrow: 'This site',
    heading: 'Accessibility',
    lede: 'This site should work for everyone who wants to read about Bothy or install it: by keyboard, with a screen reader, zoomed in, with motion reduced, in high contrast mode and with no script at all. This page says what we aim for, what was checked, and what we know is not yet good enough.',
    updated: 'Last reviewed: 18 November 2026.',
    sections: [
      {
        id: 'aim',
        heading: 'What we aim for',
        paras: [
          'The target is the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA, on every page of this site.',
          'The Israeli standard IS 5568 is based on WCAG, so meeting WCAG 2.2 AA is meant to cover its substance. This is our own aim and our own checking. The site has not been audited or certified by anyone, against WCAG or against IS 5568, and we do not claim that it conforms.',
        ],
        items: [],
      },
      {
        id: 'tested',
        heading: 'What was tested, and how',
        paras: [
          'Every page of the built site was checked in Chromium, at a desktop size (1440 by 900) and a phone width (390):',
        ],
        items: [
          'An automated scan with axe-core on every page, and a script that checks the contrast of text against its real background on the pages outside the story. Both are scripts kept with the site’s source (npm run check:a11y and check:sky), so anyone can run them again.',
          'The sky behind the home page is checked separately: its text is measured against the picture behind it at each hour of the day.',
          'Keyboard only: the skip link comes first, every control can be reached and used, the focus ring is visible on light and dark backgrounds, and the install menu follows the usual menu keys (Escape closes it, the arrow keys move through it).',
          'Structure: one main heading per page, headings in order, labelled navigation, and a language on every page.',
          'With JavaScript turned off: every page is complete and readable, the console example is a still picture with its steps written out as a list.',
          'With reduced motion, Windows high contrast mode (forced colours), more contrast and reduced transparency set in the system.',
          'Zoomed to 200 and 400 percent, at 320 CSS pixels wide with no sideways scrolling, and with wider letter, word and line spacing.',
        ],
      },
      {
        id: 'limits',
        heading: 'Known limitations',
        paras: [],
        items: [
          'No person has yet tested the site with a screen reader (NVDA, JAWS, VoiceOver or TalkBack). The checks above are automated or done by eye and keyboard.',
          'The moving sky on the home page is decoration. It is hidden from screen readers, and everything it shows is also said in words. It can be paused, and it holds still when reduced motion is set.',
          'The console shown on the home page is an example with made-up data, drawn to look like the real one. It is not a live system, and its contents are not meant to be used.',
          'The site is in English only for now. A Hebrew version is planned.',
          'The documentation is written in Markdown in the project repository; a page written there may need fixing here first.',
        ],
      },
      {
        id: 'report',
        heading: 'Reporting a problem',
        paras: [
          'If something on this site is hard or impossible to use, please tell us. Open an issue on GitHub and say which page, what you were trying to do, and what you use (browser, screen reader or other tools) if you are happy to share it. We will answer there.',
        ],
        items: [],
      },
    ],
    report: 'Report an accessibility problem on GitHub',
  },

  a11y: {
    external: 'opens another site',
    anchor: 'Link to this section',
  },
};

export type Messages = typeof en;
