/**
 * Facts the site states about the product that come from a test run rather than
 * from the release feed. Kept in one place so a re-proof is a one-line edit and
 * so a stale claim is easy to find. Words live in `i18n/en.ts`; this file holds
 * only data and ids, and every block says where it comes from.
 *
 * Source for everything below unless a block says otherwise:
 * docs/plans/thin-bothy/bothy-install.md, section 10e "Stock install of a real
 * release: v2026.11.2 (lab, 2026-11-17)", section 10f "Failure scenarios (lab,
 * 2026-11-18)" and section 15 "Modules on an installed box".
 */
export const PROVEN_RELEASE = '2026.11.2';

/** The guest the proof ran on, and what it did not have. Section 10e. */
export const LAB_GUEST = {
  os: 'Ubuntu 24.04',
  arch: 'linux/amd64',
  /** Only Docker and the Compose plugin were present: no `gh`, no registry login. */
  needed: 'Docker and Compose',
  date: '2026-11-17',
} as const;

/**
 * Lab timings, in seconds, each with the section of bothy-install.md that records it.
 * The page states them as "in our lab", never as a promise.
 */
export const LAB_TIMINGS = {
  /** Two stock passes on reset guests: 38.7 s and 24.3 s ("24 to 39 seconds"). Section 10e. */
  install: { minSeconds: 24.3, maxSeconds: 38.7, source: '10e' },
  /** A second run changed nothing and took 0.9 s ("about a second"). Section 10e. */
  rerun: { seconds: 0.9, source: '10e' },
} as const;

/** Memory, in MiB. Section 10c (container use after install) and 10f scenario 9 (the gate). */
export const MEMORY = {
  /** What `bothy install` refuses to start below: 448 MiB of container limits plus a 512 MiB reserve. */
  gateMiB: 960,
  /** Measured after a lab install: Traefik 15, console 3.4, files 19.6. */
  usedMiB: { edge: 15, console: 3.4, files: 19.6 },
} as const;

export const MEMORY_USED_TOTAL_MIB = Math.round(MEMORY.usedMiB.edge + MEMORY.usedMiB.console + MEMORY.usedMiB.files);

export type ModeId = 'bivvy' | 'bothy' | 'basecamp' | 'cairn';
export type ModeState = 'now' | 'planned';

/**
 * The four sizes (names and contents from docs/plans/thin-bothy/mode-names.md). Only Bivvy is
 * installable today: `bothy install` takes `--mode mini` only (section 15, "mode changes are not offered").
 * A mode flips to 'now' only when a stock release installs it in the lab, not before.
 * `measured` is true only where a lab figure exists.
 */
export const MODES: ReadonlyArray<{ id: ModeId; state: ModeState; measured: boolean }> = [
  { id: 'bivvy', state: 'now', measured: true },
  { id: 'bothy', state: 'planned', measured: false },
  { id: 'basecamp', state: 'planned', measured: false },
  { id: 'cairn', state: 'planned', measured: false },
];

/** Ids of the claims; the words are in en.ts (home.proof). Section 10e and 10f. */
export const PROVEN = [
  'install', // stock release, clean linux/amd64 guest, Docker only
  'checksum', // sha256 checked before anything changes
  'attestation-skip', // no gh: skipped, prints the exact command
  'rerun', // second run is a no-op
  'tamper', // tampered or mismatched release refused, state restored byte for byte
  'uninstall', // uninstall and purge
  'preflight', // port taken, docker down, low RAM, sudo: refused with the fix, nothing created
] as const;

/** Never promised. Section 10e "Unproven", 10f scenarios 8, 26, 27, 28, 30 and section 15. */
export const UNPROVEN = [
  'arm64', // images pullable, never run
  'wsl', // including Docker Desktop for WSL
  'rootless', // refused by design, never run on a real one
  'mini-host', // a 2 GiB host (lab-mini)
  'update-real', // a real update or downgrade between two real releases
  'attestation-guest', // verified on the host, not inside a guest
  'selinux',
  'ipv6',
  'desktop-hosts', // macOS and Windows run the CLI only
  'k3s', // a design, not what installs today
  'modules-real', // `bothy module add` has run against fakes, not a real release
] as const;

export type ProvenId = (typeof PROVEN)[number];
export type UnprovenId = (typeof UNPROVEN)[number];
