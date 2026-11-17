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
    title: 'Bothy: install a console for your machine like an app',
    hero: {
      heading: 'A bothy is a free shelter in the hills. This one is for your machine.',
      lede: 'Bothy is a self-hosted console for one machine. It discovers the services on a machine, shows them on one page, and gives you a reader for the files and notes kept there. You get it from one download and one command, with no checkout and nothing to build.',
      primary: 'Install Bothy',
      secondary: 'Read the docs',
      terminalLabel: 'The whole install, as typed',
      terminalNote: 'Your machine needs Docker. Nothing here runs as root.',
      copy: 'Copy',
      copied: 'Copied',
    },
    app: {
      heading: 'Installs like an app',
      intro:
        'The goal is the way you install a browser or an editor: get one file, run it, and the rest is its job. That is how it works now, for the first size.',
      steps: [
        {
          title: 'Download one binary',
          body: 'The `bothy` command is a single static file attached to each GitHub release. It carries the stack definition inside it, so there is no repository to clone and no Go, Python or Node to install.',
        },
        {
          title: 'Read the plan first',
          body: '`bothy install --dry-run` prints every action marked `do` or `skip` and changes nothing. A step marked `skip` is already true on your machine, which is why running it twice is safe.',
        },
        {
          title: 'Install',
          body: '`bothy install` pulls each image by its digest, starts the stack, then checks the bytes the server actually returns. It does not trust a status code, because a catch-all page also answers 200.',
        },
      ],
      trust: {
        heading: 'What it checks before it touches anything',
        items: [
          'The release manifest must match its own line in the release’s `checksums.txt`, and must name the same version as the binary.',
          'Every image is pulled by `sha256` digest, never by a tag, and the digest is re-checked after the pull.',
          'When the GitHub CLI is present, the release’s build attestation is verified too. When it is not, `bothy install` says it skipped that check and prints the exact command to run yourself.',
          'It writes under your home directory, never runs `sudo`, and a failure part-way is resumed by running it again.',
        ],
      },
    },
    modes: {
      heading: 'Four sizes',
      intro:
        'Bothy comes in sizes, named for the shelters people use in the hills, smallest first. Only the smallest can be installed today.',
      available: 'Installable now',
      planned: 'Designed, not built',
      items: [
        {
          name: 'Bivvy',
          tagline: 'a roof, a door, a lock',
          body: 'The console, a read-only file reader and the edge that serves them. Runs on Docker Compose.',
          status: 'available',
        },
        {
          name: 'Bothy',
          tagline: 'four walls and a fire',
          body: 'Bivvy plus metrics, logs, alerts and backups.',
          status: 'planned',
        },
        {
          name: 'Basecamp',
          tagline: 'everything before the climb',
          body: 'Bothy plus dashboards, single sign-on, a database and a cluster view.',
          status: 'planned',
        },
        {
          name: 'Cairn',
          tagline: 'stack your own stones',
          body: 'Pick modules one at a time.',
          status: 'planned',
        },
      ],
      profileLabel: 'A stepped outline rising from Bivvy to Cairn. Only the first step is built.',
    },
    status: {
      heading: 'Where it honestly stands',
      asOf: (release: string) => `Written against release ${release}.`,
      worksHeading: 'What has been shown to work',
      works: [
        'A stock install of a real release on a clean Ubuntu virtual machine that had only Docker and Compose: download the binary, `bothy install`, and the page and file reader answered with the right bytes.',
        'Running the install a second time changes nothing and takes about a second.',
        'A tampered manifest, a wrong version and two forced failures were each refused or rolled back to the previous state.',
        '`bothy uninstall` removes what it made and keeps your data and secrets unless you ask for `--purge` and type a confirmation.',
      ],
      notHeading: 'What is not there yet',
      not: [
        'Bothy, Basecamp and Cairn are plans. There is no way to install them yet.',
        'Only the Linux `amd64` binary has been run end to end. The `arm64` build exists and has never been executed.',
        'The macOS and Windows archives are command-line clients. The stack itself runs on a Linux machine with Docker.',
        'WSL and rootless Docker are untested. There is no package for apt or Homebrew yet.',
        'The attestation check inside a fresh machine is proven only where the GitHub CLI was already signed in.',
        'This site is English only for now. Hebrew is planned and the pages are built so it can be added.',
      ],
      where: 'The full record of what was measured is in the repository.',
      whereLink: 'Install notes and test results',
    },
    docsTeaser: {
      heading: 'Documentation',
      body: 'The guide is the repository’s own Markdown, rendered here from the same files. It starts with installing and ends with troubleshooting.',
      link: 'Open the guide',
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
