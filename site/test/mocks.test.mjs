// The app mocks on the Home page must be live, not pictures: every control inside one works. This fails when a mock
// holds a control that is hidden from assistive tech, inert, switched off by pointer-events, or `disabled` without a
// stated reason, and when a mock has no control at all. The pinned story console and the "See it move" video are
// the two deliberate exceptions: they carry no data-mock, so nothing here looks at them.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const MOCK_SOURCES = [
  'src/components/AfterStory.tsx',
  'src/components/new-sections/Compare.tsx',
  'src/components/new-sections/Hood.tsx',
  'src/components/chapters/InstallChapter.tsx',
];

const CONTROL = /<(button|input|select|textarea|a|label|summary)\b[^>]*>/gs;

/** Problems with the controls found in a piece of markup (HTML or JSX). */
export function controlProblems(markup) {
  const bad = [];
  let n = 0;
  for (const [tag] of markup.matchAll(CONTROL)) {
    n++;
    if (/aria-hidden\s*=\s*["{]?\s*"?true/.test(tag)) bad.push(`aria-hidden control: ${tag}`);
    if (/\binert\b/.test(tag)) bad.push(`inert control: ${tag}`);
    if (/pointer-events/.test(tag)) bad.push(`pointer-events on a control: ${tag}`);
    if (/\bdisabled\b/.test(tag) && !/data-reason\s*=/.test(tag)) bad.push(`disabled without a reason: ${tag}`);
  }
  return { n, bad };
}

/** The markup of each [data-mock] element in rendered HTML (balanced on its own tag name). */
export function mocksIn(html) {
  const out = [];
  for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*\bdata-mock="([^"]+)"[^>]*>/g)) {
    const open = new RegExp(`<${m[1]}\\b`, 'g');
    const close = new RegExp(`</${m[1]}>`, 'g');
    let depth = 0;
    let end = html.length;
    const rest = html.slice(m.index);
    const tokens = [...rest.matchAll(new RegExp(`<${m[1]}\\b|</${m[1]}>`, 'g'))];
    for (const t of tokens) {
      depth += t[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        end = m.index + t.index + t[0].length;
        break;
      }
    }
    void open;
    void close;
    out.push({ name: m[2], root: m[0], html: html.slice(m.index, end) });
  }
  return out;
}

/** Selectors in the site's CSS that mention a mock and switch its pointer off. */
export function deadMockCss(css) {
  const bad = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (
      /pointer-events\s*:\s*none/.test(body) &&
      /\[data-mock|\.mk-|\.mini\b|\.cmp\b|\.hood\b|\.hn\b|\.hs-demo\b/.test(sel)
    )
      bad.push(sel.trim());
  }
  return bad;
}

test('the sources of the app mocks have working controls and are not hidden', () => {
  for (const f of MOCK_SOURCES) {
    const src = readFileSync(join(root, f), 'utf8');
    const marks = [...src.matchAll(/data-mock=/g)].length;
    assert.ok(marks > 0, `${f} should carry a data-mock`);
    const { n, bad } = controlProblems(src);
    assert.deepEqual(bad, [], f);
    assert.ok(n >= marks, `${f}: ${marks} mocks but only ${n} controls`);
    // a mock root must not be hidden either
    assert.doesNotMatch(src, /data-mock=[^>]*aria-hidden|aria-hidden[^>]*data-mock=/, `${f}: a mock is aria-hidden`);
  }
});

test('no CSS rule turns the pointer off on a mock', () => {
  const dir = join(root, 'src/styles');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.css'))) {
    const css = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.deepEqual(deadMockCss(css), [], f);
  }
});

test('the rendered Home page, when built, has live mocks', { skip: !existsSync(join(root, 'dist/index.html')) }, () => {
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
  const mocks = mocksIn(html);
  assert.ok(mocks.length >= 6, `expected the app mocks in the page, found ${mocks.length}`);
  for (const m of mocks) {
    const { n, bad } = controlProblems(m.html);
    assert.deepEqual(bad, [], m.name);
    assert.ok(n > 0, `${m.name} has no control: it is a picture`);
    assert.doesNotMatch(m.root, /aria-hidden|inert/, `${m.name} is hidden`);
  }
});

test('the checks can fail', () => {
  assert.equal(controlProblems('<button aria-hidden="true">x</button>').bad.length, 1);
  assert.equal(controlProblems('<button disabled>x</button>').bad.length, 1);
  assert.equal(controlProblems('<button disabled data-reason="why">x</button>').bad.length, 0);
  assert.equal(controlProblems('<input inert type="checkbox"/>').bad.length, 1);
  assert.equal(controlProblems('<a style="pointer-events:none">x</a>').bad.length, 1);
  assert.equal(controlProblems('<p>just a picture</p>').n, 0);
  assert.deepEqual(deadMockCss('.mini .mk-row { pointer-events: none; }'), ['.mini .mk-row']);
  assert.deepEqual(deadMockCss('.photo { pointer-events: none; }'), []);
  const found = mocksIn('<div data-mock="a"><div><button>b</button></div></div><p>x</p>');
  assert.equal(found.length, 1);
  assert.match(found[0].html, /button/);
});
