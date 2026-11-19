/**
 * The example data the clip draws, trimmed to what it shows. It is a copy of fields in fixtures/console/*.json (the
 * fixtures themselves carry urls and labels the page must not ship, and the leak scan in check:meta rejects them in a
 * script); example.test.ts fails when a value here stops matching its fixture, so the clip cannot show a screen the
 * fixtures, and through them the product's types, no longer have.
 */
export const SERVICES: readonly {
  id: string;
  name: string;
  status: string;
  port: number | null;
  to: number | null;
  image: string;
}[] = [
  { id: 'notes-web', name: 'Notes web', status: 'up', port: 8081, to: 80, image: 'nginx:1.27-alpine' },
  { id: 'notes-api', name: 'Notes API', status: 'up', port: null, to: null, image: 'notes-api:1.4.0' },
  { id: 'notes-db', name: 'Notes DB', status: 'up', port: null, to: null, image: 'postgres:16' },
  { id: 'notes-cache', name: 'Notes cache', status: 'up', port: null, to: null, image: 'redis:7' },
  { id: 'wiki', name: 'Wiki', status: 'starting', port: 8090, to: 3000, image: 'wiki-app:2.2' },
  { id: 'dev-server', name: 'Dev server', status: 'unknown', port: 5173, to: null, image: '' },
  { id: 'backup-job', name: 'Nightly backup', status: 'stopped', port: null, to: null, image: 'backup-tool:0.9' },
];

export const TILES: readonly { key: string; label: string; num: string; of: string; sub: string }[] = [
  { key: 'services', label: 'Services', num: '5', of: ' / 6 up', sub: '0 down · 1 off' },
  { key: 'routes', label: 'Routes', num: '3', of: ' / 3', sub: 'enabled' },
  { key: 'updates', label: 'Updates', num: '1', of: ' available', sub: 'largest: wiki' },
  { key: 'backup', label: 'Last backup', num: '11h ago', of: '', sub: 'every set is fresh' },
];

export const MODULES: readonly { name: string; mib: number; installed: boolean; core: boolean }[] = [
  { name: 'edge', mib: 128, installed: true, core: true },
  { name: 'web', mib: 64, installed: true, core: true },
  { name: 'files', mib: 256, installed: true, core: false },
  { name: 'node-metrics', mib: 64, installed: false, core: false },
];
