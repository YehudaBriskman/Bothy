import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateAllowlist, loadDocs } from './docs.ts';
import { renderMarkdown, resolveLink } from './markdown.ts';
import { assertPublicDocPath, findLeaks, isPublicRepoPath } from './safety.ts';

const ctx = {
  file: 'docs/guide/a.md',
  pages: new Map([['docs/guide/b.md', 'b']]),
  exists: (p: string) => p === 'scripts/bothy' || p === 'docs/guide/b.md',
  tableLabel: 'Table',
};

test('private and unsafe doc paths are refused', () => {
  for (const bad of [
    'kb/x.md',
    'docs/kb/x.md',
    '../secret.md',
    '/etc/passwd.md',
    'guide/x.txt',
    'claude-notes/a.md',
    'guide/credentials.md',
    'a\\b.md',
  ]) {
    assert.throws(() => assertPublicDocPath(bad), Error, bad);
  }
  assert.equal(assertPublicDocPath('guide/./installing.md'), 'guide/installing.md');
});

test('the real allowlist is valid and has no private entry', async () => {
  const { default: list } = await import('../../docs-allowlist.json', { with: { type: 'json' } });
  const checked = validateAllowlist(list.files);
  assert.ok(checked.length > 5);
});

test('an allowlist entry that reaches into kb fails validation', () => {
  assert.throws(() => validateAllowlist([{ file: 'kb/README.md', slug: 'kb', group: 'start' }]));
  assert.throws(() =>
    validateAllowlist([
      { file: 'guide/a.md', slug: 'x', group: 'start' },
      { file: 'guide/b.md', slug: 'x', group: 'start' },
    ]),
  );
});

test('leak patterns catch tailnet addresses and credentials, not version numbers or digests', () => {
  assert.ok(findLeaks(`http://${['100', '117', '176', '85'].join('.')}/`).length);
  assert.ok(findLeaks('host.tail1234.ts.net').length);
  assert.ok(findLeaks('password=hunter2hunter2hunter2').length);
  assert.ok(findLeaks('ghp_' + 'a'.repeat(36)).length);
  assert.ok(findLeaks('-----BEGIN OPENSSH PRIVATE KEY-----').length);
  assert.equal(findLeaks('v2026.11.2 sha256:' + 'ab'.repeat(32) + ' 100.5 MB 10.0.0.1').length, 0);
});

test('links: pages, repo files, private areas and broken targets', () => {
  assert.equal(resolveLink('b.md#x', ctx).kind, 'page');
  assert.equal(resolveLink('../../scripts/bothy', ctx).kind, 'repo');
  assert.equal(resolveLink('../kb/README.md', ctx).kind, 'private');
  assert.equal(resolveLink('missing.md', ctx).kind, 'broken');
  assert.equal(resolveLink('https://example.com', ctx).kind, 'external');
  assert.equal(isPublicRepoPath('docs/kb/a.md'), false);
});

test('rendering: private link becomes text, broken link fails, html is escaped, callouts work', () => {
  const ok = renderMarkdown('# T\n\nsee [kb](../kb/R.md) <b>x</b>\n\n> [!note] Why\n> because\n', ctx);
  assert.ok(!ok.html.includes('href="../kb'));
  assert.ok(ok.html.includes('class="unlinked"'));
  assert.ok(ok.html.includes('&lt;b&gt;'));
  assert.ok(ok.html.includes('callout-note'));
  assert.throws(() => renderMarkdown('# T\n\n[x](nope.md)\n', ctx), /does not exist/);
});

test('the real docs render with no broken link or anchor', () => {
  const docs = loadDocs('Table');
  assert.ok(docs.length >= 10);
  for (const d of docs) assert.ok(!/href="[^"]*(\/kb\/|claude-notes)/.test(d.html), d.source);
});

test('each table region is named by the heading above it, and a header row with no words is dropped', () => {
  const md = [
    '# T',
    '',
    '## Ports',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '| c | d |',
    '|---|---|',
    '| 3 | 4 |',
    '',
    '## Checklist',
    '',
    '| | |',
    '|---|---|',
    '| x | y |',
    '',
  ].join('\n');
  const { html } = renderMarkdown(md, ctx);
  const labels = [...html.matchAll(/role="region" aria-label="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Table: Ports', 'Table: Ports (2)', 'Table: Checklist']);
  assert.doesNotMatch(html, /<th[^>]*>\s*<\/th>/);
});
