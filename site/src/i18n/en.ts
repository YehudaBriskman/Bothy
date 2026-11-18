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
  },

  theme: {
    label: 'Colour scheme',
    auto: 'Match system',
    light: 'Light',
    dark: 'Dark',
  },

  footer: {
    line: 'Bothy is open source. This site is built from the same repository as the software.',
    version: (v: string) => `Newest release: ${v}`,
    build: 'Built from the repository. No scripts from other sites, no analytics, no cookies.',
    source: 'Source',
    releases: 'Releases on GitHub',
    security: 'Security policy',
  },

  home: {
    title: 'BothyBox: a free shelter in the hills, for your machine',
    chapterNav: 'The story, chapter by chapter',
    hero: {
      heading: 'BothyBox',
      line: 'A free shelter in the hills, for your machine.',
      lede: 'A bothy is an unlocked mountain hut that anyone may use, kept up by the people who use it. Bothy is software with the same manners: one console for the machine you run things on, free and open source.',
      primary: 'Install Bothy',
      secondary: 'Read the docs',
      skipInstall: 'Skip to install',
      cue: 'Read the story',
      footnote:
        'The sky behind this page is a still picture chosen by your browser’s light or dark setting. This page makes no request to another site and sets no cookie.',
      copy: 'Copy',
      copied: 'Copied',
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
      art: 'A small stone hut on a dark hillside, one window lit.',
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
    },
    sizes: {
      heading: 'Four sizes',
      lead: 'Named for the shelters walkers use, smallest first. Only the smallest installs today.',
      now: 'Installable now',
      planned: 'Planned, not built',
      cost: 'Cost',
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
    },
  },

  install: {
    title: 'Install Bothy',
    description:
      'Download the bothy binary from the release page, verify it, and run bothy install. The exact commands, what each one does, and what is not supported yet.',
    heading: 'Install Bothy',
    lede: 'Four commands on a Linux machine that already has Docker. Read each one first; none of them needs root.',
    release: {
      latest: (v: string, date: string) => `Newest release: ${v}, published ${date}.`,
      proven: (v: string) => `The lab proof ran release ${v}.`,
      newer: (proven: string) =>
        `This is newer than release ${proven}, the one the install proof last ran against. It is built by the same pipeline; it has not been proven separately.`,
      page: 'Release page',
    },
    need: {
      heading: 'Before you start',
      items: [
        'A Linux machine, `amd64`, with Docker and the Compose v2 plugin. `bothy install` checks both and stops with the exact fix if one is missing.',
        'Enough free memory for the stack’s limits (the preflight checks this) and a free port 80. Move it with `--port`; expose it beyond this machine with `--bind 0.0.0.0` (it listens on `127.0.0.1` by default).',
        'Your user must be able to run `docker` without `sudo`. Bothy never calls `sudo`.',
      ],
    },
    steps: {
      download: {
        title: 'Download the binary and the checksums',
        body: 'Both are release assets. The archive holds one file, `bothy`.',
      },
      verify: {
        title: 'Verify what you downloaded',
        body: 'The first command checks the archive against the release’s `checksums.txt`. The second checks that GitHub attested the build; it needs the `gh` command and is optional, but it is the one that ties the file to this repository.',
      },
      place: {
        title: 'Put it on your path',
        body: 'Any directory on your `PATH` will do. `~/.local/bin` needs no root.',
      },
      install: {
        title: 'Read the plan, then install',
        body: 'The dry run prints the plan and the preflight results and changes nothing. The real run prints the address when it is up.',
        after:
          'It prints `Bivvy is up` with the address. Open it in a browser on the same machine, or on another if you passed `--bind`.',
      },
    },
    later: {
      heading: 'Afterwards',
      items: [
        '`bothy install` again is safe: finished steps are skipped, and an interrupted run resumes.',
        'To move to a newer release, download that release’s binary and run `bothy update`. It verifies the new release, keeps the previous generation, and rolls back if the new one does not come up healthy.',
        '`bothy uninstall` stops the stack and removes what it generated. Your data, your secrets and the pulled images stay. `bothy uninstall --purge` deletes them too, after you type a confirmation phrase.',
      ],
    },
    platforms: {
      heading: 'Which archive',
      intro: 'Every release carries these. Only the first row is supported for running a stack.',
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
      heading: 'Not supported yet',
      items: [
        'Installing the larger sizes (Bothy, Basecamp, Cairn).',
        'Running the stack on macOS or Windows. Those archives are clients only.',
        'Running the `arm64` build: it compiles and is attached to every release, but nobody has run it.',
        'WSL, rootless Docker, and a system-wide install for a headless server.',
        'A package for apt, dnf, Homebrew or winget.',
      ],
    },
    older: {
      heading: 'Prefer to read a repository first?',
      body: 'There is an older path that clones the repository and runs `just up`. It starts the full development stack, not the small one, and the guide describes it.',
      link: 'The installing guide',
    },
  },

  docs: {
    title: 'Documentation',
    description: 'The Bothy guide, rendered from the Markdown in the repository.',
    heading: 'Documentation',
    lede: 'These pages are the repository’s own guide, rendered from the same Markdown files. Where a page links to a file that is not part of the guide, the link goes to the source on GitHub.',
    notTranslated: 'The documentation is English only.',
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
  },

  changelog: {
    title: 'Releases',
    description: 'Every Bothy release, from the repository’s release notes.',
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

  a11y: {
    external: 'opens another site',
    anchor: 'Link to this section',
  },
};

export type Messages = typeof en;
