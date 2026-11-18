import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LAB_TIMINGS, MEMORY, MODES, PROVEN, UNPROVEN } from '../../facts.ts';
import { en } from '../../i18n/en.ts';

test('only Bivvy is claimed as installable now', () => {
  assert.deepEqual(
    MODES.filter((m) => m.state === 'now').map((m) => m.id),
    ['bivvy'],
  );
});

test('a cost is shown only where it was measured', () => {
  for (const m of MODES) {
    if (m.measured) assert.equal(m.id, 'bivvy');
  }
  assert.ok(MEMORY.gateMiB > 0 && LAB_TIMINGS.install.minSeconds < LAB_TIMINGS.install.maxSeconds);
});

test('every proven and unproven claim has words, and every mode has a card', () => {
  for (const id of PROVEN) {
    if (id !== 'install') assert.ok(en.home.proof.shown[id], `proven: ${id}`);
  }
  for (const id of UNPROVEN) assert.ok(en.home.proof.not[id], `unproven: ${id}`);
  for (const m of MODES) assert.ok(en.home.sizes.items[m.id].name, `mode: ${m.id}`);
});

test('the unproven list keeps the items the plan forbids promising', () => {
  for (const id of ['arm64', 'wsl', 'rootless', 'mini-host', 'update-real', 'k3s'] as const) {
    assert.ok((UNPROVEN as readonly string[]).includes(id), id);
  }
});
