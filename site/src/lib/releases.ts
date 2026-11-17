import fixture from '../../fixtures/releases.json' with { type: 'json' };

/**
 * The release feed.
 *
 * Source of truth is the repository's GitHub releases; what the BUILD reads is
 * `fixtures/releases.json`, a committed snapshot written by
 * `npm run refresh-releases`. A build therefore needs no network and gives the
 * same output twice, and the site can only ever list a version that had a
 * published release when the snapshot was taken.
 */

export interface ReleaseAsset {
  name: string;
  size: number;
  sha256: string | null;
  url: string;
}

export interface ReleaseChange {
  title: string;
  pr: number;
  url: string;
}

export interface ReleaseManifestSummary {
  schema: number;
  commit: string;
  images: number;
  platforms: string[];
  thirdParty: number;
}

export interface Release {
  tag: string;
  version: string;
  name: string;
  /** YYYY-MM-DD, UTC. */
  date: string;
  url: string;
  changes: ReleaseChange[];
  compareUrl: string | null;
  assets: ReleaseAsset[];
  manifest: ReleaseManifestSummary | null;
}

export interface ReleaseFeed {
  generated: string;
  repo: string;
  releases: Release[];
}

const VERSION = /^\d{4}\.\d+\.\d+$/;

/** Throws on anything that would put a wrong or empty feed on the site. */
export function validateFeed(raw: unknown): ReleaseFeed {
  const doc = raw as { schema?: number; generated?: string; repo?: string; releases?: Release[] };
  if (!doc || doc.schema !== 1) throw new Error('releases fixture: schema must be 1');
  if (!doc.generated || !/^\d{4}-\d{2}-\d{2}$/.test(doc.generated))
    throw new Error('releases fixture: bad "generated" date');
  if (!doc.repo || !Array.isArray(doc.releases) || !doc.releases.length) {
    throw new Error('releases fixture: no releases. An empty feed is a fault, not a state to ship.');
  }
  const seen = new Set<string>();
  for (const r of doc.releases) {
    if (!VERSION.test(r.version) || r.tag !== `v${r.version}`)
      throw new Error(`releases fixture: ${r.tag} is not vYYYY.M.N`);
    if (seen.has(r.tag)) throw new Error(`releases fixture: ${r.tag} appears twice`);
    seen.add(r.tag);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new Error(`releases fixture: ${r.tag} has a bad date`);
    if (!r.url.startsWith(`https://github.com/${doc.repo}/`))
      throw new Error(`releases fixture: ${r.tag} links off the repository`);
    for (const a of r.assets) {
      if (a.sha256 !== null && !/^[0-9a-f]{64}$/.test(a.sha256))
        throw new Error(`releases fixture: ${r.tag}/${a.name} has a bad sha256`);
    }
  }
  return doc as ReleaseFeed;
}

export function loadFeed(): ReleaseFeed {
  return validateFeed(fixture);
}

/** The newest release that carries a runnable archive for this platform, else just the newest. */
export function latestRelease(feed: ReleaseFeed): Release {
  const withArchive = feed.releases.find((r) => r.assets.some((a) => /_linux_amd64\.tar\.gz$/.test(a.name)));
  return withArchive ?? feed.releases[0]!;
}

export function downloadBase(feed: ReleaseFeed, release: Release): string {
  return `https://github.com/${feed.repo}/releases/download/${release.tag}`;
}

/** `bothy_2026.11.2_linux_amd64.tar.gz` -> `linux/amd64`, or null for files that are not CLI archives. */
export function platformOf(assetName: string): string | null {
  const m = /^bothy_[\d.]+_([a-z]+)_([a-z0-9]+)\.(?:tar\.gz|zip)$/.exec(assetName);
  return m ? `${m[1]}/${m[2]}` : null;
}
