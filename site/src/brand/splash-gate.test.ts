// The first-visit splash's gate: it plays once per browser session on the home page's hero, and never with reduced
// motion, a blocked or forgetful sessionStorage, a repeat visit, a page opened mid-way, or under automation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPLASH_KEY, shouldPlaySplash, splashParam, type SplashEnv } from './splash-gate.ts';

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
