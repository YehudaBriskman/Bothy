import assert from 'node:assert/strict';
import { test } from 'node:test';
import health from '../../fixtures/console/health.json' with { type: 'json' };
import modules from '../../fixtures/console/modules.json' with { type: 'json' };
import services from '../../fixtures/console/services.json' with { type: 'json' };
import { MODULES, SERVICES, TILES } from './example.ts';

test('the clip draws only what the example fixtures hold', () => {
  assert.equal(SERVICES.length, services.nodes.length);
  for (const [i, n] of services.nodes.entries()) {
    const s = SERVICES[i]!;
    const p = n.ports[0];
    assert.deepEqual(
      [s.id, s.name, s.status, s.port, s.to, s.image],
      [
        n.id,
        n.name,
        n.status,
        p?.hostPort ?? null,
        p && 'containerPort' in p ? p.containerPort : null,
        n.container?.image ?? '',
      ],
    );
  }
  assert.equal(MODULES.length, modules.modules.length);
  for (const [i, m] of modules.modules.entries()) {
    const x = MODULES[i]!;
    assert.deepEqual(
      [x.name, x.mib, x.installed, x.core],
      [m.name, m.memory_mib, m.installed, 'core' in m && !!m.core],
    );
  }
  assert.equal(TILES.length, health.tiles.length);
  for (const [i, t] of health.tiles.entries()) {
    const x = TILES[i]!;
    assert.deepEqual(
      [x.key, x.label, x.num, x.of, x.sub],
      [t.key, t.label, 'num' in t.value ? t.value.num : t.value.text, 'of' in t.value ? t.value.of : '', t.sub],
    );
  }
});
