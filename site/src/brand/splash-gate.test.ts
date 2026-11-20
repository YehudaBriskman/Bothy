// The first-visit splash's gate: it plays once per browser session on the home page's hero, and never with reduced
// motion, a page opened on a #fragment, or under automation. It plays on every load, a refresh included.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  INTRO_CLASS,
  INTRO_FAILSAFE_MS,
  introScript,
  shouldPlaySplash,
  splashParam,
  type SplashEnv,
} from './splash-gate.ts';

const env = (over: Partial<SplashEnv> = {}): SplashEnv => ({
  search: '',
  reducedMotion: false,
  hasHero: true,
  atTop: true,
  automated: false,
  ...over,
});

test('plays on every load, a refresh included: nothing is remembered between loads', () => {
  for (let i = 0; i < 3; i++) assert.equal(shouldPlaySplash(env()), true);
});

test('never with prefers-reduced-motion, not even when forced', () => {
  assert.equal(shouldPlaySplash(env({ reducedMotion: true })), false);
  assert.equal(shouldPlaySplash(env({ reducedMotion: true, search: '?splash=1' })), false);
});

test('only on the hero, never on a #fragment link, never under automation', () => {
  assert.equal(shouldPlaySplash(env({ hasHero: false })), false);
  assert.equal(shouldPlaySplash(env({ atTop: false })), false);
  assert.equal(shouldPlaySplash(env({ automated: true })), false);
});

test('?splash=1 forces it (automation, a #fragment link); ?splash=0 stops it', () => {
  const forced = { search: '?splash=1', automated: true, atTop: false };
  assert.equal(shouldPlaySplash(env(forced)), true);
  assert.equal(shouldPlaySplash(env({ search: '?splash=1', hasHero: false })), false);
  assert.equal(shouldPlaySplash(env({ search: '?splash=0' })), false);
  assert.equal(splashParam('?a=b&splash=hold'), 'force');
  assert.equal(splashParam('?a=b'), null);
});

// The inline head script: the gate's own source, run in a bare context with only the globals a browser gives it.
function runIntro(o: { search?: string; hash?: string; reduce?: boolean; webdriver?: boolean } = {}) {
  const classes = new Set<string>();
  const timers: { fn: () => void; ms: number }[] = [];
  const sandbox = {
    URLSearchParams,
    location: { search: o.search ?? '', hash: o.hash ?? '' },
    matchMedia: () => ({ matches: !!o.reduce }),
    navigator: { webdriver: o.webdriver ?? false },
    setTimeout: (fn: () => void, ms: number) => void timers.push({ fn, ms }),
    document: {
      documentElement: {
        classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      },
    },
  };
  runInNewContext(introScript(), sandbox);
  return { classes, timers };
}

test('the inline script hides the page on every load and always arms the 3.5 s failsafe that shows it again', () => {
  const r = runIntro();
  assert.ok(r.classes.has(INTRO_CLASS));
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0]!.ms, INTRO_FAILSAFE_MS);
  assert.ok(INTRO_FAILSAFE_MS <= 3500);
  r.timers[0]!.fn();
  assert.equal(r.classes.size, 0);
});

test('the inline script leaves the page alone: reduced motion, automation, #fragment, ?splash=0', () => {
  for (const o of [
    { reduce: true },
    { reduce: true, search: '?splash=1' },
    { webdriver: true },
    { hash: '#sizes' },
    { search: '?splash=0' },
  ]) {
    const r = runIntro(o);
    assert.equal(r.classes.size, 0, JSON.stringify(o));
    assert.equal(r.timers.length, 0, JSON.stringify(o));
  }
  assert.ok(runIntro({ webdriver: true, search: '?splash=1' }).classes.has(INTRO_CLASS));
  assert.ok(runIntro().classes.has(INTRO_CLASS)); // and again: no memory between loads
  assert.ok(runIntro().classes.has(INTRO_CLASS));
});

test('styles/intro.css hides exactly what brand/splash.ts brings back, with opacity only, inside 2.6 to 3.0 s', async () => {
  const { INTRO_ITEMS, DURATION } = await import('./splash.ts');
  const css = readFileSync(new URL('../styles/intro.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const list = css
    .match(/:is\(([^)]*)\)/)![1]!
    .split(',')
    .map((s) => s.trim());
  assert.deepEqual(list, [...INTRO_ITEMS]);
  assert.doesNotMatch(css, /display|visibility|transform|height|width/);
  assert.match(css, /prefers-reduced-motion: no-preference/);
  assert.ok(DURATION >= 2600 && DURATION <= 3000, String(DURATION));
  assert.ok(DURATION + 300 < INTRO_FAILSAFE_MS);
});
