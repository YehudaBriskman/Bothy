import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestRelease, loadFeed, platformOf, validateFeed } from './releases.ts';

test('the committed fixture is a valid, non-empty feed', () => {
  const feed = loadFeed();
  assert.ok(feed.releases.length > 0);
  assert.match(latestRelease(feed).version, /^\d{4}\.\d+\.\d+$/);
});

test('an empty or malformed feed is refused', () => {
  assert.throws(() => validateFeed({ schema: 1, generated: '2026-01-01', repo: 'a/b', releases: [] }));
  assert.throws(() => validateFeed({ schema: 2 }));
  assert.throws(() =>
    validateFeed({
      schema: 1,
      generated: '2026-01-01',
      repo: 'a/b',
      releases: [{ tag: 'v1', version: '1', date: '2026-01-01', url: 'https://github.com/a/b/x', assets: [] }],
    }),
  );
});

test('platformOf reads archive names only', () => {
  assert.equal(platformOf('bothy_2026.11.2_linux_amd64.tar.gz'), 'linux/amd64');
  assert.equal(platformOf('bothy_2026.11.2_windows_arm64.zip'), 'windows/arm64');
  assert.equal(platformOf('checksums.txt'), null);
});
