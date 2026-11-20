import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { hourScript } from './hour-script.ts';

/** Run the head script with a fake page and report what it set and preloaded. */
function run(search: string, hour: number) {
  const attrs: Record<string, string> = {};
  const links: Array<Record<string, string>> = [];
  const RealDate = Date;
  const sandbox = {
    location: { search },
    history: {} as Record<string, string>,
    Date: class extends RealDate {
      constructor() {
        super(2026, 10, 20, Math.floor(hour), Math.round((hour % 1) * 60));
      }
    },
    document: {
      documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) },
      createElement: () => {
        const l: Record<string, string> = {};
        links.push(l);
        return l;
      },
      head: { appendChild: () => undefined },
    },
  };
  runInNewContext(hourScript(), sandbox);
  return { hour: attrs['data-hour'], links };
}

test('the head script names the hour the engine would', () => {
  assert.equal(run('', 3).hour, 'dawn'); // before dawn: the dawn sky, never night
  assert.equal(run('', 12).hour, 'noon');
  assert.equal(run('', 17.6).hour, 'golden');
  assert.equal(run('', 23).hour, 'sunset'); // after sunset: the sunset sky
  assert.equal(run('?hour=8.6', 3).hour, 'morning'); // ?hour wins
});

test('it preloads the photograph of that hour, desktop and phone, as AVIF', () => {
  const day = run('', 12).links;
  assert.deepEqual(
    day.map((l) => l.href),
    ['/sky/day-desk.avif', '/sky/day-phone.avif'],
  );
  assert.ok(day.every((l) => l.rel === 'preload' && l.as === 'image' && l.type === 'image/avif'));
  assert.deepEqual(
    run('', 18.7).links.map((l) => l.href),
    ['/sky/dusk-desk.avif', '/sky/dusk-phone.avif'],
  );
});
