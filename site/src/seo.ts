/**
 * What each page says about itself to search engines and link previews (build plan S10).
 *
 * One row per page, keyed by the page's path without its locale prefix. The prerender (src/prerender.tsx) reads the
 * row for the <title>, the meta description, Open Graph and Twitter tags; scripts/og.mjs reads `image` and `card` to
 * draw the share images; scripts/check-seo.mjs fails the build when a row is missing or out of range. The words follow
 * the site's honesty rule (src/facts.ts): only what is true of the software today, nothing about scale, speed or
 * platforms that the lab has not shown.
 *
 *   title        at most 60 characters (what a results page shows before it cuts)
 *   description  110 to 160 characters (long enough to say something, short enough not to be cut)
 *   image        which share image (public/og/<image>.jpg) the page uses
 *
 * A docs page without a row falls back to its Markdown summary, and the check fails if that summary is out of range,
 * so a new document cannot ship with a cut-off preview unnoticed.
 */

export const SEO_LIMITS = { titleMax: 60, descriptionMin: 110, descriptionMax: 160 } as const;

export type OgImage = 'home' | 'install' | 'docs' | 'about' | 'changelog';

/** Every share image: 1200 x 630 JPEG (Facebook, LinkedIn and X all render JPEG; not all render WebP). */
export const OG_SIZE = { width: 1200, height: 630 } as const;

/**
 * What each share image says, and which sky photograph (public/sky/<photo>-desk.webp) it is drawn on.
 * `alt` is the image's text alternative (og:image:alt, twitter:image:alt): it says what the picture shows.
 */
export const OG_CARDS: Record<OgImage, { photo: 'day' | 'dusk'; heading: string; line: string; alt: string }> = {
  home: {
    photo: 'dusk',
    heading: 'BothyBox',
    line: 'A free shelter in the hills, for your machine.',
    alt: 'The Bothy wordmark over an evening sky, with the line: a free shelter in the hills, for your machine.',
  },
  install: {
    photo: 'day',
    heading: 'Install Bothy',
    line: 'The release binary or a source checkout. Tested in our lab on Linux amd64 with Docker.',
    alt: 'Install Bothy, over a daytime sky: the release binary or a source checkout, tested on Linux amd64 with Docker.',
  },
  docs: {
    photo: 'day',
    heading: 'Bothy documentation',
    line: 'The guide, rendered from the Markdown in the repository.',
    alt: 'Bothy documentation, over a daytime sky: the guide, rendered from the Markdown in the repository.',
  },
  about: {
    photo: 'dusk',
    heading: 'About Bothy',
    line: 'Where the name comes from, and how the software and this site are made.',
    alt: 'About Bothy, over an evening sky: where the name comes from, and how the software and this site are made.',
  },
  changelog: {
    photo: 'day',
    heading: 'Bothy releases',
    line: 'Every release and its notes, from the repository.',
    alt: 'Bothy releases, over a daytime sky: every release and its notes, from the repository.',
  },
};

export interface SeoEntry {
  title: string;
  description: string;
  image: OgImage;
}

/** The pages outside the docs, and the docs pages, by path without locale. */
export const SEO: Record<string, SeoEntry> = {
  '/': {
    title: 'BothyBox: a free shelter in the hills, for your machine',
    description:
      'Bothy is a free, open-source console for one machine. Install it from a single download, and see what works today and what does not yet.',
    image: 'home',
  },
  '/install/': {
    title: 'Install Bothy: the release binary or a source checkout',
    description:
      'Install Bothy from the release binary, with checksums and attestation commands, or from a checkout. What was tested, what was not, how to uninstall.',
    image: 'install',
  },
  '/docs/': {
    title: 'Bothy documentation',
    description:
      'The Bothy guide, rendered from the Markdown in the repository: installing, the bothy command, configuring, the console, services, roles and more.',
    image: 'docs',
  },
  '/about/': {
    title: 'About Bothy: the name, the software and this site',
    description:
      'Where the name Bothy comes from, what the software is, how it is made, and what this site does with your visit: nothing. No analytics, no cookies.',
    image: 'about',
  },
  '/changelog/': {
    title: 'Bothy releases',
    description:
      'Every Bothy release and its notes, taken from the repository’s GitHub releases when this site was built, with links to each release on GitHub.',
    image: 'changelog',
  },
  '/404.html': {
    title: 'Page not found - Bothy',
    description:
      'That address is not part of the Bothy site. It may have moved, or it may never have existed. The home page, install guide and docs are linked here.',
    image: 'home',
  },

  '/docs/overview/': {
    title: 'The Bothy guide - Bothy docs',
    description:
      'Bothy is a self-discovering console for one machine. The guide covers installing it, the files you will edit, what the console can do, and who may do it.',
    image: 'docs',
  },
  '/docs/installing/': {
    title: 'Installing Bothy from a source checkout - Bothy docs',
    description:
      'The two source-checkout install paths, and where both end: a checkout you can read, a .env of generated secrets, and the stack’s containers running.',
    image: 'docs',
  },
  '/docs/the-cli/': {
    title: 'The bothy command - Bothy docs',
    description:
      'bothy installs a checkout, then acts as a dispatcher: a small shell script that finds your checkout and hands most of what you type to its justfile.',
    image: 'docs',
  },
  '/docs/upgrading/': {
    title: 'Upgrading Bothy - Bothy docs',
    description:
      'An upgrade is two commands that update two different things: bothy upgrade moves the box to a newer release, bothy self-update replaces the script.',
    image: 'docs',
  },
  '/docs/configuring/': {
    title: 'The files you will actually edit - Bothy docs',
    description:
      'Bothy is Compose stacks, a Traefik directory, two policy files and one .env. This page maps a change you want onto the file that decides it.',
    image: 'docs',
  },
  '/docs/the-console/': {
    title: 'Operating Bothy from the console - Bothy docs',
    description:
      'The Bothy web console: the Overview you land on, Control for services, ports, routes and topology, Bothy Files for documents, and Settings.',
    image: 'docs',
  },
  '/docs/services/': {
    title: 'Adding a service to the stack - Bothy docs',
    description:
      'How to add a container that Bothy itself runs: publish a host port, reach it at the node address and that port, and why a Traefik Host() rule matches nothing.',
    image: 'docs',
  },
  '/docs/files/': {
    title: 'Bothy Files - Bothy docs',
    description:
      'Bothy Files shows every document on the box, read straight off the disk it lives on: rendered, searchable, linkable and editable, with no second copy.',
    image: 'docs',
  },
  '/docs/projects/': {
    title: 'Declaring a project - Bothy docs',
    description:
      'Bothy discovers Traefik routers and Docker containers by itself. A declaration covers the rest: a project that is switched off, or one made of host processes.',
    image: 'docs',
  },
  '/docs/themes/': {
    title: 'Themes - Bothy docs',
    description:
      'Bothy ships five themes and loads any you add. A theme is one .css file in one directory: no rebuild, no npm, no restart, and it survives a rebuild.',
    image: 'docs',
  },
  '/docs/monitoring/': {
    title: 'Monitoring - Bothy docs',
    description:
      'Every container on the box gets logs and metrics with no per-service setup, because of how the collectors find their targets. What is collected, and where.',
    image: 'docs',
  },
  '/docs/roles/': {
    title: 'Roles - Bothy docs',
    description:
      'Bothy’s four roles, viewer, editor, operator and shell, are flat and never imply one another, so a terminal is never granted by accident. What each one gets.',
    image: 'docs',
  },
  '/docs/settings/': {
    title: 'Settings - Bothy docs',
    description:
      'Bothy Settings: a grouped menu, a search box and pages of setting blocks, each with its own address. Where each setting lives, and how to open it.',
    image: 'docs',
  },
  '/docs/troubleshooting/': {
    title: 'When something is wrong - Bothy docs',
    description:
      'Start with one command, just doctor: containers, ports, routes, metrics targets, DNS, disk, memory and backups. Then the traps that cost the most time.',
    image: 'docs',
  },
};

/** The row for a page; a page with no row (a new doc) gets the given fallbacks, which the check then holds to range. */
export function seoFor(pathWithoutLocale: string, fallback: { title: string; description: string }): SeoEntry {
  const row = SEO[pathWithoutLocale];
  if (row) return row;
  const image: OgImage = pathWithoutLocale.startsWith('/docs/') ? 'docs' : 'home';
  return { ...fallback, image };
}
