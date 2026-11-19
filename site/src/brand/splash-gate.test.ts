// The first-visit splash's gate: it plays once per browser session on the home page's hero, and never with reduced
// motion, a blocked or forgetful sessionStorage, a repeat visit, a page opened mid-way, or under automation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  INTRO_CLASS,
  INTRO_FAILSAFE_MS,
  SPLASH_KEY,
  introScript,
  shouldPlaySplash,
  splashParam,
  type SplashEnv,
} from './splash-gate.ts';

function memory() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

const env = (over: Partial<SplashEnv> = {}, store = memory()): SplashEnv => ({
  search: '',
  reducedMotion: false,
  hasHero: true,
  atTop: true,
  automated: false,
  storage: () => store,
  ...over,
});

test('plays on the first visit of a session and sets the flag', () => {
  const store = memory();
  assert.equal(shouldPlaySplash(env({}, store)), true);
  assert.equal(store.m.get(SPLASH_KEY), '1');
});

test('a repeat visit in the same session does not replay it', () => {
  const store = memory();
  assert.equal(shouldPlaySplash(env({}, store)), true);
  assert.equal(shouldPlaySplash(env({}, store)), false);
  assert.equal(shouldPlaySplash(env({}, store)), false);
});

test('never with prefers-reduced-motion, not even when forced, and the flag is not spent', () => {
  const store = memory();
  assert.equal(shouldPlaySplash(env({ reducedMotion: true }, store)), false);
  assert.equal(shouldPlaySplash(env({ reducedMotion: true, search: '?splash=1' }, store)), false);
  assert.equal(store.m.size, 0);
});

test('sessionStorage blocked: reading the property, reading the key, or writing it throws, so it does not play', () => {
  const boom = () => {
    throw new DOMException('denied', 'SecurityError');
  };
  assert.equal(shouldPlaySplash(env({ storage: boom })), false);
  assert.equal(shouldPlaySplash(env({ storage: () => ({ getItem: boom, setItem: () => {} }) })), false);
  assert.equal(shouldPlaySplash(env({ storage: () => ({ getItem: () => null, setItem: boom }) })), false);
});

test('a store that accepts the write but keeps nothing does not play (it would replay on every page)', () => {
  assert.equal(shouldPlaySplash(env({ storage: () => ({ getItem: () => null, setItem: () => {} }) })), false);
});

test('only on the hero, only from the top of the page, never under automation', () => {
  assert.equal(shouldPlaySplash(env({ hasHero: false })), false);
  assert.equal(shouldPlaySplash(env({ atTop: false })), false);
  assert.equal(shouldPlaySplash(env({ automated: true })), false);
});

test('?splash=1 forces it (repeat visit, automation, storage blocked) without touching the flag; ?splash=0 stops it', () => {
  const store = memory();
  store.m.set(SPLASH_KEY, '1');
  const forced = { search: '?splash=1', automated: true, atTop: false };
  assert.equal(shouldPlaySplash(env(forced, store)), true);
  assert.equal(
    shouldPlaySplash(
      env({
        ...forced,
        storage: () => {
          throw new Error('blocked');
        },
      }),
    ),
    true,
  );
  assert.equal(shouldPlaySplash(env({ search: '?splash=1', hasHero: false })), false);
  const fresh = memory();
  assert.equal(shouldPlaySplash(env({ search: '?splash=0' }, fresh)), false);
  assert.equal(fresh.m.size, 0);
  assert.equal(splashParam('?a=b&splash=hold'), 'force');
  assert.equal(splashParam('?a=b'), null);
});

// The inline head script: the gate's own source, run in a bare context with only the globals a browser gives it.
function runIntro(o: { search?: string; hash?: string; reduce?: boolean; webdriver?: boolean; store?: unknown } = {}) {
  const classes = new Set<string>();
  const timers: { fn: () => void; ms: number }[] = [];
  const store = o.store ?? memory();
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
  Object.defineProperty(sandbox, 'sessionStorage', {
    get: () => {
      if (store === 'throws') throw new Error('SecurityError');
      return store;
    },
  });
  runInNewContext(introScript(), sandbox);
  return { classes, timers };
}

test('the inline script hides the page on a first visit and always arms the 3.5 s failsafe that shows it again', () => {
  const r = runIntro();
  assert.ok(r.classes.has(INTRO_CLASS));
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0]!.ms, INTRO_FAILSAFE_MS);
  assert.ok(INTRO_FAILSAFE_MS <= 3500);
  r.timers[0]!.fn();
  assert.equal(r.classes.size, 0);
});

test('the inline script leaves the page alone: repeat visit, reduced motion, automation, #fragment, ?splash=0, no storage', () => {
  const seen = memory();
  seen.setItem(SPLASH_KEY, '1');
  for (const o of [
    { store: seen },
    { reduce: true },
    { reduce: true, search: '?splash=1' },
    { webdriver: true },
    { hash: '#sizes' },
    { search: '?splash=0' },
    { store: 'throws' },
  ]) {
    const r = runIntro(o);
    assert.equal(r.classes.size, 0, JSON.stringify(o));
    assert.equal(r.timers.length, 0, JSON.stringify(o));
  }
  assert.ok(runIntro({ webdriver: true, search: '?splash=1' }).classes.has(INTRO_CLASS));
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
