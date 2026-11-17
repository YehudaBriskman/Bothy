// Rewrites site/fixtures/releases.json from the GitHub releases of this repository.
//
// The BUILD never runs this: it reads the committed fixture, so a build needs no
// network and is reproducible. This is the deliberate, reviewable step that moves
// the fixture forward (run it, read the diff, commit it). A release workflow can
// call it later; nothing about the format depends on who runs it.
//
//   node scripts/refresh-releases.mjs            # public API, no token needed
//   GITHUB_TOKEN=... node scripts/refresh-releases.mjs   # higher rate limit
//
// Only published, non-draft releases are kept, so the site cannot list a version
// that does not exist. The manifest summary is read from each release's own
// `release-manifest.json` asset (the format scripts/gen-release-manifest.py
// writes: schema 1, version, commit, images{}, third_party{}, assets{}).
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'YehudaBriskman/Bothy';
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../fixtures/releases.json');

const headers = { accept: 'application/vnd.github+json', 'user-agent': 'bothy-site-refresh' };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function json(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** "* title by @user in https://github.com/o/r/pull/12" -> {title, pr, url}. */
function parseChanges(body) {
  const changes = [];
  for (const line of (body ?? '').split(/\r?\n/)) {
    const m = /^\s*[*-]\s+(.*?)\s+by\s+@[\w-]+\s+in\s+(https:\/\/github\.com\/\S+?\/pull\/(\d+))\s*$/.exec(line);
    if (m) changes.push({ title: m[1], pr: Number(m[3]), url: m[2] });
  }
  return changes;
}

const raw = await json(`https://api.github.com/repos/${REPO}/releases?per_page=100`);
const releases = [];
for (const r of raw) {
  if (r.draft || r.prerelease) continue;
  const version = String(r.tag_name).replace(/^v/, '');
  const assets = r.assets
    .map((a) => ({
      name: a.name,
      size: a.size,
      sha256: typeof a.digest === 'string' && a.digest.startsWith('sha256:') ? a.digest.slice(7) : null,
      url: a.browser_download_url,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  let manifest = null;
  const m = r.assets.find((a) => a.name === 'release-manifest.json');
  if (m) {
    const res = await fetch(m.browser_download_url, { headers: { 'user-agent': headers['user-agent'] } });
    if (res.ok) {
      const doc = await res.json();
      manifest = {
        schema: doc.schema,
        commit: doc.commit,
        images: Object.keys(doc.images ?? {}).length,
        platforms: [...new Set(Object.values(doc.images ?? {}).flatMap((i) => i.platforms ?? []))].sort(),
        thirdParty: Object.keys(doc.third_party ?? {}).length,
      };
    }
  }

  releases.push({
    tag: r.tag_name,
    version,
    name: r.name ?? r.tag_name,
    date: String(r.published_at).slice(0, 10),
    url: r.html_url,
    changes: parseChanges(r.body),
    compareUrl: (/\*\*Full Changelog\*\*:\s*(\S+)/.exec(r.body ?? '') ?? [])[1] ?? null,
    assets,
    manifest,
  });
}
releases.sort((a, b) =>
  a.date === b.date ? b.version.localeCompare(a.version, 'en', { numeric: true }) : b.date.localeCompare(a.date),
);

const fixture = { schema: 1, repo: REPO, generated: new Date().toISOString().slice(0, 10), releases };
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`refresh-releases: ${releases.length} releases -> ${out}`);
