// Dev-box portal — discovers what's running instead of being a hand-written list.
//
// Data comes from two read-only APIs, both same-origin under /-/api/* (see
// ~/stacks/edge/dynamic/portal-api.yml), so there's no CORS anywhere:
//
//   Traefik  -> every route, including host processes (@file). The SKELETON.
//   Docker   -> ports, health, images, compose labels.        ENRICHMENT.
//
// Either can die and the page still renders. See loadAll() / the failure notes.
//
// Everything above the "RENDER" banner is PURE — no DOM, no fetch, no globals —
// so the join can be tested in node against the live APIs. That's deliberate:
// the join is the part with real bugs in it.

export const BASE = 'dev.test';
const STACK_ROOT = '/home/devssh/stacks/';
const INFRA_PROJECTS = new Set(['edge', 'portal']);

// ── Pure: hostname handling ────────────────────────────────────────────────

// Extract the Host() value from a Traefik rule.
//
// Returns null for ANYTHING it doesn't fully understand — `PathPrefix(`/`)`
// (portal-fallback has no Host at all), HostRegexp, multi-host Host(`a`,`b`).
// Guessing here silently files cards under the wrong project, which is worse
// than not showing them: a null falls through to the Routes tab, visibly.
export function extractHost(rule) {
  if (typeof rule !== 'string') return null;
  if (/HostRegexp/i.test(rule)) return null;
  const m = rule.match(/Host\(`([^`]+)`\)/);
  if (!m) return null;
  // Host(`a`,`b`) — more than one host in a single call. Don't pick one.
  if (/Host\(`[^`]+`\s*,/.test(rule)) return null;
  return m[1];
}

// Where does a hostname sit in the dev.test hierarchy?
//   dev.test            -> depth 0, the portal itself
//   grafana.dev.test    -> depth 1, leaf 'grafana',  parent null
//   s3.cvops.dev.test   -> depth 2, leaf 's3',       parent 'cvops'
export function nest(host) {
  if (!host) return { depth: null, parent: null, leaf: null };
  if (host === BASE) return { depth: 0, parent: null, leaf: null };
  if (!host.endsWith('.' + BASE)) return { depth: null, parent: null, leaf: host };
  const labels = host.slice(0, -(BASE.length + 1)).split('.');
  return {
    depth: labels.length,
    leaf: labels[0],
    parent: labels.length > 1 ? labels[labels.length - 1] : null,
  };
}

// ── Pure: classification ───────────────────────────────────────────────────

// project vs stack vs infra, from the compose file's location on disk.
// No hand-maintained list: a project is simply a compose file that doesn't
// live under ~/stacks.
export function classify(container) {
  if (!container) return { group: 'host', groupKind: 'project' };
  const labels = container.Labels || {};
  const cfg = labels['com.docker.compose.project.config_files'];
  const proj = labels['com.docker.compose.project'];
  // minikube and anything else started outside compose has neither.
  if (!cfg || !proj) return { group: 'unmanaged', groupKind: 'infra' };
  const first = cfg.split(',')[0];
  if (first.startsWith(STACK_ROOT)) {
    return { group: proj, groupKind: INFRA_PROJECTS.has(proj) ? 'infra' : 'stack' };
  }
  return { group: proj, groupKind: 'project' };
}

const titleCase = (s) =>
  String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

// ORDER MATTERS — first substring match wins. Vendor-prefixed images mean the
// specific product must precede the vendor: grafana/loki would otherwise match
// 'grafana' and show a dashboard icon.
const IMAGE_ICONS = [
  ['loki', '📜'], ['promtail', '📜'], ['dozzle', '📜'],
  ['grafana', '📊'], ['prometheus', '🎯'],
  ['traefik', '🚦'], ['portainer', '🐳'], ['socket-proxy', '🔌'],
  ['nginx', '🌐'], ['postgres', '🐘'], ['redis', '🧠'], ['kafka', '🌊'],
  ['garage', '🧊'], ['wiki', '📚'], ['minikube', '☸️'],
  ['cadvisor', '📈'], ['node-exporter', '🖥️'], ['exporter', '📈'],
];
// Accepts either a normalized node (container.image) or a raw docker container
// (container.Image) — the two differ in case and mixing them silently drops
// every icon to a letter fallback.
export function iconFor(node) {
  const img = String(node.container?.image || node.container?.Image || '').toLowerCase();
  for (const [k, v] of IMAGE_ICONS) if (img.includes(k)) return v;
  return (node.name || '?').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '•';
}

// Display name for a compose project: `dev.portal.project` on ANY of its
// containers names the whole project. One label fixes every breadcrumb, panel
// title and unrouted card — titleCase can't know that "cvops" is "CVOps".
export function projectNames(containers = []) {
  const m = new Map();
  for (const c of containers) {
    const L = c.Labels || {};
    const p = L['com.docker.compose.project'], n = L['dev.portal.project'];
    if (p && n) m.set(p, n);
  }
  return m;
}

// Name with zero labels required. Labels only add polish — if this needs labels
// to be *correct*, the defaults are wrong.
export function defaultName(host, container, names = new Map()) {
  const n = nest(host);
  const proj = container?.Labels?.['com.docker.compose.project'];
  const nice = (g) => names.get(g) || titleCase(g);

  let base = container?.Labels?.['com.docker.compose.service'];
  if (!base) base = n.leaf;
  if (!base) base = (container?.Names?.[0] || '').replace(/^\//, '');
  if (!base) base = 'unknown';
  const title = titleCase(base);

  // Routed under a project: s3.cvops.dev.test -> "CVOps · S3"
  if (n.parent) return `${nice(n.parent)} · ${title}`;
  // Unrouted but owned by a project: cvops-postgres-1 -> "CVOps · Postgres",
  // so it can't be confused with the stack's own Postgres in another panel.
  if (!host && proj && classify(container).groupKind === 'project' && titleCase(proj) !== title) {
    return `${nice(proj)} · ${title}`;
  }
  return title;
}

// Non-HTTP things are listed but not linked — clicking an S3 or postgres
// endpoint in a browser is never what you wanted.
const NON_HTTP = ['garage', 'postgres', 'redis', 'kafka:', 'apache/kafka', 'socket-proxy'];
export function isBrowsable(host, container) {
  if (!host) return false;
  const img = (container?.Image || '').toLowerCase();
  return !NON_HTTP.some((k) => img.includes(k));
}

// ── Pure: status ───────────────────────────────────────────────────────────

// Health IS a top-level field on /containers/json (docker 29 / API 1.55).
// Strictly better than a no-cors probe, which can't tell a 502 error page from
// success. The probe is kept ONLY for @file routes with no container.
export function statusOf(container, kind) {
  if (!container) return 'unknown';           // resolved by probe if routed
  // Health is an OBJECT here - {Status, FailingStreak} - not a string, so
  // comparing it directly to 'healthy' was always false and every container
  // fell through to the State check below. That made 'starting' and
  // 'unhealthy' unreachable: a container failing its healthcheck showed up.
  // State is a plain string, so the second branch is only a shape guard.
  const h = container.Health?.Status ?? container.State?.Health?.Status;
  if (h === 'healthy') return 'up';
  if (h === 'unhealthy') return 'down';
  if (h === 'starting') return 'starting';
  return container.State === 'running' ? 'up' : 'down';
}

// ── Pure: the join ─────────────────────────────────────────────────────────

// router -> service -> server url -> devnet IP -> container
export function merge(routers = [], services = [], containers = []) {
  const svcByKey = new Map(services.map((s) => [s.name, s]));
  const names = projectNames(containers);

  // devnet ONLY. Traefik runs --providers.docker.network=devnet so every
  // docker-provider server URL is a devnet IP. Indexing all networks would
  // collide: 172.18.0.x and 172.19.0.x both exist on this box.
  const ctrByIp = new Map();
  for (const c of containers) {
    const ip = c.NetworkSettings?.Networks?.devnet?.IPAddress;
    if (ip) ctrByIp.set(ip, c);
  }
  // Fallback join: containers carry their own traefik.http.routers.<n>.rule
  // labels, so router->container survives a stale Traefik server IP.
  const ctrByRouter = new Map();
  for (const c of containers) {
    for (const k of Object.keys(c.Labels || {})) {
      const m = k.match(/^traefik\.http\.routers\.([^.]+)\./);
      if (m) ctrByRouter.set(m[1], c);
    }
  }

  const nodes = [];
  const claimed = new Set();

  // Pass 1 — everything Traefik routes.
  for (const r of routers) {
    const host = extractHost(r.rule);
    if (!host) continue;                       // Routes tab only (portal-fallback)

    // router.service has NO @provider suffix, but service.name does.
    // Except dashboard@docker, whose service is already 'api@internal'.
    const svcKey = r.service?.includes('@') ? r.service : `${r.service}@${r.provider}`;
    const svc = svcByKey.get(svcKey);
    const urls = svc?.loadBalancer?.servers?.map((s) => s.url).filter(Boolean) || [];

    let container = null;
    for (const u of urls) {
      let ip;
      try { ip = new URL(u).hostname; } catch { continue; }
      if (ctrByIp.has(ip)) { container = ctrByIp.get(ip); break; }
    }
    if (!container) container = ctrByRouter.get(String(r.name).split('@')[0]) || null;
    if (container) claimed.add(container.Id);

    nodes.push(makeNode({
      route: r, host, serverUrls: urls, container, names,
      kind: container ? 'routed' : 'orphan-route',
    }));
  }

  // Pass 2 — containers with no route that still publish a port. "Route OR
  // published port" is the correct definition of "a thing a human can reach".
  // Drops promtail/exporters (no route, no port) — they're plumbing.
  for (const c of containers) {
    if (claimed.has(c.Id)) continue;
    if (!(c.Ports || []).some((p) => p.PublicPort)) continue;
    nodes.push(makeNode({ route: null, host: null, container: c, names, kind: 'unrouted' }));
  }

  return nodes;
}

function makeNode({ route, host, serverUrls = [], container, kind, names = new Map() }) {
  const n = nest(host);
  const cls = classify(container);
  const L = container?.Labels || {};
  const pick = (key, fallback) => L[`dev.portal.${key}`] ?? fallback;

  const name = pick('name', defaultName(host, container, names));
  const path = pick('path', '');
  const browsable = isBrowsable(host, container);

  const node = {
    id: route ? route.name : `container:${container?.Id?.slice(0, 12)}`,
    kind,
    name,
    host: host || null,
    path,
    url: host && browsable ? `http://${host}${path}` : null,
    browsable,
    // hostname nesting BEATS config_files: it's what puts cvops-tilt@file (no
    // container at all) in the CVOps panel. Makes the DNS convention load-bearing.
    group: pick('group', n.parent || cls.group),
    groupKind: pick('groupKind', n.parent ? 'project' : cls.groupKind),
    parent: n.parent,
    depth: n.depth,
    order: Number(pick('order', 100)) || 100,
    hidden: pick('hidden', 'false') === 'true',
    route: route ? {
      router: route.name, provider: route.provider, rule: route.rule,
      priority: route.priority, entryPoints: route.entryPoints,
      status: route.status, serverUrls,
    } : null,
    container: container ? {
      id: container.Id.slice(0, 12),
      name: (container.Names?.[0] || '').replace(/^\//, ''),
      image: container.Image,
      state: container.State,
      statusText: container.Status,
      health: container.Health || null,
      labels: L,
    } : null,
    ports: portsOf(container),
    status: statusOf(container, kind),
  };
  node.icon = pick('icon', iconFor(node));
  node.desc = pick('desc', defaultDesc(node));
  return node;
}

function defaultDesc(node) {
  if (node.kind === 'orphan-route' && node.route?.provider === 'file') {
    return 'Host process reached through the edge. Expect 502 when it is not running.';
  }
  if (node.kind === 'orphan-route') {
    return 'Route registered, but no container found on devnet — it may have stopped.';
  }
  if (node.kind === 'unrouted') {
    return `${node.container?.image || 'Container'} — published port, no edge route.`;
  }
  return `${node.container?.image || ''}`.trim() || 'Routed service.';
}

// Docker lists 0.0.0.0 and :: as separate rows for the same bind — collapse
// them, prefer IPv4, or every port shows twice.
export function portsOf(container) {
  if (!container?.Ports) return [];
  const seen = new Map();
  for (const p of container.Ports) {
    if (!p.PublicPort) continue;               // internal-only, not reachable
    const ip = p.IP === '::' ? '0.0.0.0' : (p.IP || '0.0.0.0');
    const key = `${ip}:${p.PublicPort}/${p.Type}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      hostIp: ip,
      hostPort: p.PublicPort,
      containerPort: p.PrivatePort,
      proto: p.Type,
      scope: ip === '127.0.0.1' ? 'loopback' : 'public',
    });
  }
  return [...seen.values()].sort((a, b) => a.hostPort - b.hostPort);
}

// Every published port on the box, flattened — the collision map.
export function allPorts(containers = []) {
  const rows = [];
  for (const c of containers) {
    const cls = classify(c);
    for (const p of portsOf(c)) {
      rows.push({
        ...p,
        container: (c.Names?.[0] || '').replace(/^\//, ''),
        image: c.Image,
        group: cls.group,
        groupKind: cls.groupKind,
      });
    }
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER — everything below touches the DOM. Everything above is pure.
// ═══════════════════════════════════════════════════════════════════════════

// @file routers have no container to label, so overrides live here. Two entries
// isn't a config system. If this reaches ~8, promote it to a fetched portal.json.
const HOST_OVERRIDES = {
  'tilt.cvops.dev.test': { icon: '🔧', desc: 'Build logs, resource status and manual triggers for the CVOps dev loop. Needs `tilt up --host=0.0.0.0`.' },
};

// Last-resort floor: shown only if BOTH APIs are unreachable. This is the page
// you open when things are broken, so it must never be blank.
const KNOWN_HOSTS = [
  ['dev.test', 'Portal'], ['grafana.dev.test', 'Grafana'], ['prometheus.dev.test', 'Prometheus'],
  ['dozzle.dev.test', 'Dozzle'], ['portainer.dev.test', 'Portainer'], ['kafka.dev.test', 'Kafka UI'],
  ['wiki.dev.test', 'Wiki.js'], ['traefik.dev.test', 'Traefik'], ['cvops.dev.test', 'CVOps'],
];

const ACCENTS = ['--v', '--c', '--am', '--em', '--p'];
const POLL_OK = 10_000, POLL_FAIL = 60_000, MAX_BACKOFF = 3;
const state = { nodes: [], ports: [], routers: [], errors: [], at: 0, fails: 0, tab: 'services', q: '', filter: 'all',
  sort: { key: 'hostPort', dir: 1 }, sig: null, portSig: null, routeSig: null };
const $ = (s, r = document) => r.querySelector(s);
const el = (t, cls, txt) => { const e = document.createElement(t); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

// ── fetch ──────────────────────────────────────────────────────────────────
async function getJSON(path, signal) {
  const r = await fetch(path, { signal, cache: 'no-store' });
  if (!r.ok) { const e = new Error(`${r.status}`); e.status = r.status; e.path = path; throw e; }
  return r.json();
}
async function loadAll() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    // allSettled, not all: partial results are first-class. Traefik is the
    // skeleton, docker is enrichment — either can die alone.
    const [routers, services, containers] = await Promise.allSettled([
      getJSON('/-/api/traefik/http/routers', ac.signal),
      getJSON('/-/api/traefik/http/services', ac.signal),
      getJSON('/-/api/docker/containers/json', ac.signal),
    ]);
    const errors = [];
    const R = routers.status === 'fulfilled' ? routers.value : (errors.push({ src: 'traefik', e: routers.reason }), []);
    // Recorded like the other two. A failure here is not fatal - merge()
    // falls back to the label join - but it silently turns the Routes tab's
    // targets into guesses, and it used to leave no trace at all.
    const S = services.status === 'fulfilled' ? services.value : (errors.push({ src: 'traefik services', e: services.reason }), []);
    const C = containers.status === 'fulfilled' ? containers.value : (errors.push({ src: 'docker', e: containers.reason }), []);
    if (!R.length && !C.length) throw new Error('both APIs unreachable');
    return { routers: R, nodes: merge(R, S, C), ports: allPorts(C), errors };
  } finally { clearTimeout(t); }
}

// ── grouping ───────────────────────────────────────────────────────────────
// Projects get one panel each. Stack collapses into ONE panel: each stack
// service is its own compose project (monitoring, mgmt, kafka, wiki, postgres,
// redis), which would otherwise render six near-empty panels for no gain.
function panelize(nodes) {
  const vis = nodes.filter((n) => !n.hidden);
  // A project's display name comes from its own depth-1 node if labelled, so
  // "cvops" can present as "CVOps" in breadcrumbs without a second label.
  const nice = new Map();
  for (const n of vis) {
    const L = n.container?.labels || {};
    if (L['dev.portal.project']) nice.set(n.group, L['dev.portal.project']);
  }
  const title = (g) => nice.get(g) || g.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  const byOrder = (a, b) => (a.depth ?? 9) - (b.depth ?? 9) || a.order - b.order || a.name.localeCompare(b.name);

  const panels = [];
  const projects = [...new Set(vis.filter((n) => n.groupKind === 'project').map((n) => n.group))].sort();
  for (const g of projects) panels.push({ title: title(g), sub: 'project · ' + g, nodes: vis.filter((n) => n.group === g).sort(byOrder) });

  const stack = vis.filter((n) => n.groupKind === 'stack').sort((a, b) => a.group.localeCompare(b.group) || byOrder(a, b));
  if (stack.length) panels.push({ title: 'Stack', sub: 'shared dev services · ' + [...new Set(stack.map((n) => n.group))].join(' · '), nodes: stack });

  const infra = vis.filter((n) => n.groupKind === 'infra').sort(byOrder);
  if (infra.length) panels.push({ title: 'Infrastructure', sub: 'the edge itself · usually you can ignore this', nodes: infra });
  return panels;
}

// ── services tab ───────────────────────────────────────────────────────────
function cardFor(node, i) {
  const ov = HOST_OVERRIDES[node.host] || {};
  const clickable = node.browsable && node.url;
  const c = el(clickable ? 'a' : 'div', 'card');
  c.dataset.id = node.id;                    // stable key for reconciliation
  c.style.setProperty('--i', String(i));
  if (clickable) { c.href = node.url; c.title = node.url; c.target = '_blank'; c.rel = 'noopener noreferrer'; }

  const row = el('div', 'row');
  row.append(el('div', 'ico', ov.icon || node.icon));
  const meta = el('div');
  const nm = el('div', 'nm', node.name);
  const dot = el('span', 'dot');
  dot.dataset.state = node.status;                 // never touches className
  dot.title = node.container?.statusText || node.status;
  nm.append(dot);
  if (node.route?.provider === 'file') nm.append(Object.assign(el('span', 'badge', 'host process'), { title: 'Runs on the host, not in a container' }));
  if (node.kind === 'orphan-route' && node.route?.provider === 'docker') nm.append(el('span', 'badge', 'no container'));
  meta.append(nm, el('div', 'pt', node.host || node.ports.map((p) => `:${p.hostPort}`).join(' ') || node.container?.name || ''));
  row.append(meta);

  c.append(row, el('div', 'desc', ov.desc || node.desc));
  const go = el('span', clickable ? 'go' : 'go cli');
  go.textContent = clickable ? 'Open ' : (node.ports.length ? `${node.ports[0].proto.toUpperCase()} · not a web UI` : 'no route');
  if (clickable) go.insertAdjacentHTML('beforeend', '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>');
  c.append(go);
  return c;
}

// Signature of everything the Services tab actually displays. Poll returns are
// usually byte-identical, so this lets us skip the DOM entirely most of the time.
function sigOf(nodes) {
  return nodes.map((n) => `${n.id}|${n.status}|${n.name}|${n.url}|${n.desc}`).join('\n');
}

function renderServices() {
  const root = $('#tab-services');
  const q = state.q.toLowerCase();
  let panels = panelize(state.nodes);
  if (q) {
    panels = panels
      .map((p) => ({ ...p, nodes: p.nodes.filter((n) => `${n.name} ${n.host} ${n.group} ${n.container?.image || ''}`.toLowerCase().includes(q)) }))
      .filter((p) => p.nodes.length);
  }

  // Nothing displayed has changed -> touch nothing. Rebuilding identical DOM
  // re-runs the entrance animation on every card, which reads as the whole page
  // flashing/jumping every poll. This guard is why the page sits still.
  const sig = state.tab + '\u0000' + q + '\u0000' + sigOf(panels.flatMap((p) => p.nodes)) + '\u0000' + panels.map((p) => p.title).join(',');
  if (sig === state.sig && root.querySelector('.cat')) return;
  state.sig = sig;

  // Clear the loading skeleton, any error/empty state, and the static floor.
  // The floor's .cat has no data-panel, so the reconciler below would never
  // remove it and real panels would stack underneath it.
  root.querySelectorAll('.skel, .state, .cat:not([data-panel])').forEach((e) => e.remove());
  if (!panels.length) { root.textContent = ''; root.append(emptyState(`No services match “${state.q}”`)); return; }

  // ── reconcile panels by title (stable key) ───────────────────────────────
  const keep = new Set();
  panels.forEach((p, i) => {
    keep.add(p.title);
    let cat = root.querySelector(`.cat[data-panel="${CSS.escape(p.title)}"]`);
    if (!cat) {
      cat = el('div', 'cat reveal');
      cat.dataset.panel = p.title;
      const head = el('div', 'cat-head');
      head.append(el('span', 'cat-idx'));
      const tw = el('div'); tw.append(el('h3'), el('div', 'cat-sub'));
      head.append(tw, el('span', 'tail'), el('span', 'cnt'));
      cat.append(head, el('div', 'grid'));
      root.append(cat);
      observeReveals(root);
    }
    cat.style.setProperty('--acc', `var(${ACCENTS[i % ACCENTS.length]})`);
    setText(cat.querySelector('.cat-idx'), String(i + 1).padStart(2, '0'));
    setText(cat.querySelector('h3'), p.title);
    setText(cat.querySelector('.cat-sub'), p.sub);
    setText(cat.querySelector('.cnt'), String(p.nodes.length));

    // ── reconcile cards by node id ─────────────────────────────────────────
    const grid = cat.querySelector('.grid');
    const alive = new Set();
    p.nodes.forEach((n, j) => {
      alive.add(n.id);
      let card = grid.querySelector(`[data-id="${CSS.escape(n.id)}"]`);
      if (!card) { card = cardFor(n, j); grid.append(card); }   // new -> animates once, correctly
      else patchCard(card, n);                                   // existing -> update in place, no animation
      card.style.setProperty('--i', String(j));
    });
    grid.querySelectorAll('[data-id]').forEach((c) => { if (!alive.has(c.dataset.id)) c.remove(); });
  });
  root.querySelectorAll('.cat[data-panel]').forEach((c) => { if (!keep.has(c.dataset.panel)) c.remove(); });

  probeOrphans();
}

const setText = (e, v) => { if (e && e.textContent !== v) e.textContent = v; };

// Update an existing card without replacing it. Every write is guarded by a
// comparison so we never dirty the DOM (or restart a transition) for no reason.
function patchCard(card, n) {
  const ov = HOST_OVERRIDES[n.host] || {};
  const dot = card.querySelector('.dot');
  if (dot && dot.dataset.state !== n.status) {
    dot.dataset.state = n.status;                       // transitions colour smoothly
    dot.title = n.container?.statusText || n.status;
  }
  setText(card.querySelector('.ico'), ov.icon || n.icon);
  const nm = card.querySelector('.nm');
  if (nm && nm.firstChild && nm.firstChild.nodeType === 3) setText(nm.firstChild, n.name);
  setText(card.querySelector('.pt'), n.host || n.ports.map((p) => `:${p.hostPort}`).join(' ') || n.container?.name || '');
  setText(card.querySelector('.desc'), ov.desc || n.desc);
  const url = n.browsable && n.url ? n.url : null;
  if (url && card.tagName === 'A' && card.getAttribute('href') !== url) { card.href = url; card.title = url; card.target = '_blank'; card.rel = 'noopener noreferrer'; }
}

// ── ports tab ──────────────────────────────────────────────────────────────
const PORT_COLS = [
  ['hostPort', 'Host'], ['containerPort', '→ Container'], ['container', 'Container'],
  ['group', 'Group'], ['proto', 'Proto'], ['scope', 'Scope'],
];
function renderPorts() {
  const root = $('#tab-ports');
  // Same anti-flicker guard as the Services tab: identical data -> no DOM work.
  // Without this the table is destroyed and rebuilt every 10s, which throws away
  // focus, text selection and scroll position mid-read.
  const sig = 'ports\u0000' + state.q + '\u0000' + (state.filter || 'all') + '\u0000' + state.sort.key + state.sort.dir +
    '\u0000' + state.ports.map((r) => `${r.hostIp}:${r.hostPort}>${r.containerPort}|${r.container}|${r.scope}`).join(';');
  const focused = document.activeElement?.id === 'q';
  if (sig === state.portSig && root.querySelector('.tbl')) return;
  state.portSig = sig;
  root.textContent = '';
  if (!state.ports.length) {
    return root.append(errState('Container data unavailable',
      'Ports come from Docker — Traefik does not know about them. The socket-proxy looks unreachable. Everything else on this page still works.'));
  }
  const bar = el('div', 'tbar');
  const inp = Object.assign(el('input'), { type: 'search', id: 'q', placeholder: 'Filter ports…   /', value: state.q });
  inp.addEventListener('input', debounce(() => { state.q = inp.value; state.portSig = null; setHash(); renderPorts(); }, 120));
  const chips = el('div', 'chips');
  for (const [f, label] of [['all', 'All'], ['public', 'Exposed'], ['loopback', 'Loopback']]) {
    const b = el('button', state.filter === f || (!state.filter && f === 'all') ? 'on' : '', label);
    b.onclick = () => { state.filter = f; state.portSig = null; renderPorts(); };
    chips.append(b);
  }
  const cnt = el('span', 'cnt');
  bar.append(inp, chips, cnt);

  let rows = state.ports.slice();
  if (state.filter && state.filter !== 'all') rows = rows.filter((r) => r.scope === state.filter);
  const q = state.q.toLowerCase();
  if (q) rows = rows.filter((r) => `${r.hostPort} ${r.containerPort} ${r.container} ${r.group} ${r.image} ${r.scope}`.toLowerCase().includes(q));
  const { key, dir } = state.sort;
  rows.sort((a, b) => (typeof a[key] === 'number' ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key]))) * dir || a.hostPort - b.hostPort);
  cnt.textContent = `${rows.length} of ${state.ports.length}`;

  const wrap = el('div', 'tbl-wrap'), tbl = el('table', 'tbl'), thead = el('thead'), htr = el('tr');
  for (const [k, label] of PORT_COLS) {
    const th = el('th', null, label); th.dataset.sort = k;
    if (key === k) th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
    th.onclick = () => { state.sort = { key: k, dir: key === k ? -dir : 1 }; state.portSig = null; renderPorts(); };
    htr.append(th);
  }
  thead.append(htr);
  const tb = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    // Show the address that works from where you're reading, not 0.0.0.0.
    const shown = r.hostIp === '0.0.0.0' ? location.hostname : r.hostIp;
    const c1 = el('td'); const a = el(r.scope === 'public' ? 'a' : 'span', 'mono', `${shown}:${r.hostPort}`);
    if (r.scope === 'public') { a.href = `http://${shown}:${r.hostPort}`; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.title = `bound on ${r.hostIp}`; c1.append(a);
    tr.append(c1, el('td', 'mono', String(r.containerPort)), el('td', null, r.container), el('td', 'mono', r.group), el('td', 'mono', r.proto));
    const c6 = el('td'); c6.append(el('span', `tag ${r.scope}`, r.scope === 'public' ? 'exposed' : 'loopback')); tr.append(c6);
    tb.append(tr);
  }
  tbl.append(thead, tb); wrap.append(tbl); root.append(bar, wrap);
  // Rebuilding the toolbar blurs the filter box mid-keystroke; restore it.
  if (focused) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}

// ── routes tab ─────────────────────────────────────────────────────────────
function renderRoutes() {
  const root = $('#tab-routes');
  const sig = 'routes\u0000' + state.routers.map((r) => `${r.name}|${r.rule}|${r.status}`).join(';');
  if (sig === state.routeSig && root.querySelector('.tbl')) return;
  state.routeSig = sig;
  root.textContent = '';
  if (!state.routers.length) return root.append(errState('Traefik API unreachable', 'Check edge/dynamic/portal-api.yml is loaded: docker logs traefik'));
  const byRouter = new Map(state.nodes.filter((n) => n.route).map((n) => [n.route.router, n]));
  const wrap = el('div', 'tbl-wrap'), tbl = el('table', 'tbl');
  tbl.innerHTML = '<thead><tr><th>Router</th><th>Rule</th><th>Provider</th><th>Service</th><th>Target</th><th>State</th></tr></thead>';
  const tb = el('tbody');
  for (const r of state.routers.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const n = byRouter.get(r.name), tr = el('tr');
    tr.append(el('td', 'mono', r.name.split('@')[0]), el('td', 'mono', r.rule), el('td', 'mono', r.provider || '—'), el('td', 'mono', r.service || '—'),
      el('td', 'mono', n?.route?.serverUrls?.join(', ') || n?.container?.name || '—'));
    const st = el('td');
    if (n?.kind === 'orphan-route' && r.provider === 'file') st.append(el('span', 'tag warn', 'host process'));
    else if (n?.kind === 'orphan-route') st.append(el('span', 'tag bad', 'no container'));
    else if (r.status === 'enabled') st.append(el('span', 'tag', 'ok'));
    else st.append(el('span', 'tag bad', r.status || '?'));
    tr.append(st); tb.append(tr);
  }
  tbl.append(tb); wrap.append(tbl); root.append(wrap);
}

// ── shared UI ──────────────────────────────────────────────────────────────
function emptyState(msg) {
  const s = el('div', 'state'); s.append(el('h4', null, msg));
  const b = el('a', 'btn ghost', 'Clear filter'); b.href = 'javascript:void 0';
  b.onclick = () => { state.q = ''; setHash(); render(); };
  s.append(b); return s;
}
function errState(title, body) {
  const s = el('div', 'state err'); s.append(el('h4', null, title), el('p', null, body));
  const b = el('a', 'btn ghost', 'Retry'); b.href = 'javascript:void 0'; b.onclick = () => tick();
  s.append(b); return s;
}
function staticFloor() {
  const root = $('#tab-services');
  if (root.querySelector('.state.err')) return;   // already showing; don't rebuild (it would flicker)
  root.textContent = '';
  root.append(errState('Cannot reach the APIs', 'Showing known service names only — live status, ports and projects are unavailable. Traefik or the portal API routes may be down. The links below still work if the services do.'));
  const cat = el('div', 'cat reveal in'); cat.style.setProperty('--acc', 'var(--v)');
  const grid = el('div', 'grid');
  KNOWN_HOSTS.forEach(([h, name], i) => grid.append(cardFor({ name, host: h, url: `http://${h}`, browsable: true, icon: '•', desc: 'Known service — status unavailable.', status: 'unknown', ports: [], order: 100 }, i)));
  cat.append(grid); root.append(cat);
  probeAll(KNOWN_HOSTS.map(([h]) => h));
}

// no-cors probe: ONLY for things with no container to ask (host processes,
// static floor). Everything else uses Docker's Health, which is honest.
function probeOrphans() {
  for (const n of state.nodes) {
    if (n.kind !== 'orphan-route' || !n.url) continue;
    probe(n.url).then((ok) => {
      n.status = ok ? 'up' : 'down';
      document.querySelectorAll(`.card[title="${n.url}"] .dot`).forEach((d) => { d.dataset.state = n.status; });
    });
  }
}
function probeAll(hosts) {
  hosts.forEach((h) => probe(`http://${h}/`).then((ok) => {
    document.querySelectorAll(`.card[title="http://${h}"] .dot`).forEach((d) => { d.dataset.state = ok ? 'up' : 'down'; });
  }));
}
const probe = (u) => Promise.race([
  fetch(u, { mode: 'no-cors', cache: 'no-store' }).then(() => true),
  new Promise((r) => setTimeout(() => r(false), 4500)),
]).catch(() => false);

// ── hero / freshness ───────────────────────────────────────────────────────
function renderHero() {
  const up = state.nodes.filter((n) => n.status === 'up').length;
  const projects = new Set(state.nodes.filter((n) => n.groupKind === 'project').map((n) => n.group)).size;
  const stacks = new Set(state.nodes.filter((n) => n.groupKind === 'stack').map((n) => n.group)).size;
  const pulse = $('.pulse'), txt = $('#status-txt');
  if (state.fails === 0) {
    // state.errors was written on every poll and read by nothing, so a page
    // running on half its data looked identical to a healthy one. A partial
    // failure is not a full one, so it stays here but says which source died.
    const degraded = state.errors.length ? ` · ${state.errors.map((x) => x.src).join(', ')} unreachable` : '';
    txt.textContent = `${up}/${state.nodes.length} up · ${projects} project${projects === 1 ? '' : 's'} · ${stacks} stacks${degraded}`;
    if (pulse) pulse.style.background = state.errors.length ? 'var(--wait)' : 'var(--ok)';
  } else {
    const age = Math.round((Date.now() - state.at) / 1000);
    txt.textContent = state.at ? `Stale · last seen ${age}s ago · retrying` : 'Cannot reach APIs · retrying';
    if (pulse) { pulse.style.background = state.at ? 'var(--wait)' : 'var(--down)'; pulse.style.animation = 'none'; }
  }
  setNum('#n-services', state.nodes.length); setNum('#n-projects', projects);
  setNum('#n-ports', state.ports.length); setNum('#n-stacks', stacks);
  document.querySelectorAll('main, #tab-services, #tab-ports, #tab-routes').forEach((e) => e.classList.toggle('stale', state.fails > 0));
}
const setNum = (sel, v) => { const e = $(sel); if (e) { e.dataset.count = String(v); e.textContent = String(v); } };

// ── tabs / hash ────────────────────────────────────────────────────────────
const TABS = new Set(['services', 'ports', 'routes']);
function readHash() {
  const [tab = 'services', ...rest] = location.hash.slice(1).split('/');
  return { tab: TABS.has(tab) ? tab : 'services', q: decodeURIComponent(rest.join('/') || '') };
}
// replaceState, not location.hash= : otherwise every keystroke is a back entry.
function setHash() {
  const h = '#' + state.tab + (state.q ? '/' + encodeURIComponent(state.q) : '');
  history.replaceState(null, '', h);
}
function route() {
  const { tab, q } = readHash();
  state.tab = tab; state.q = q; state.sig = null;  // tab/filter change -> force a repaint
  for (const t of TABS) {
    $(`#tab-${t}`).hidden = t !== tab;
    $(`.tabs button[data-tab="${t}"]`)?.setAttribute('aria-selected', String(t === tab));
  }
  render();
}
function render() {
  renderHero();
  if (state.tab === 'services') {
    if (state.nodes.length) renderServices();
    else if (state.fails > 0) staticFloor();   // tried and failed -> known-hosts floor
    // else: no data yet and no failure -> leave the skeleton up
  }
  else if (state.tab === 'ports') renderPorts();
  else renderRoutes();
}

// ── behaviours that must survive re-render ─────────────────────────────────
// The originals were one-shot querySelectorAll at parse time: they'd silently
// do nothing on dynamically created cards.
let io;
function observeReveals(root) {
  io ??= new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12 });
  root.querySelectorAll('.reveal:not(.in)').forEach((e) => io.observe(e));
}
function delegateSpotlight() {
  document.addEventListener('mousemove', (e) => {
    const c = e.target.closest?.('.card'); if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    c.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const isTyping = (t) => /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName) || t?.isContentEditable;

// ── poll loop ──────────────────────────────────────────────────────────────
let timer;
async function tick() {
  try {
    const d = await loadAll();
    Object.assign(state, { nodes: d.nodes, ports: d.ports, routers: d.routers, errors: d.errors, at: Date.now(), fails: 0 });
    render();
  } catch (e) {
    state.fails++; renderHero();
    if (!state.nodes.length) render();     // never blank: fall to the static floor
  } finally { schedule(); }
}
function schedule() {
  clearTimeout(timer);
  if (document.hidden) return;             // this page lives in a background tab for days
  timer = setTimeout(tick, state.fails >= MAX_BACKOFF ? POLL_FAIL : POLL_OK);
}

// ── init ───────────────────────────────────────────────────────────────────
export function init() {
  // FIRST: opt into the JS-only styles. portal.css hides .reveal only under
  // html.js, so if this module never runs the page still renders in full.
  document.documentElement.classList.add('js');
  const via = $('#via'); if (via) via.textContent = location.hostname.startsWith('100.') ? 'tailscale · ' + location.hostname : location.hostname;
  document.querySelectorAll('.tabs button[data-tab]').forEach((b) => { b.onclick = () => { location.hash = '#' + b.dataset.tab; }; });
  addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  addEventListener('keydown', (e) => {
    if (isTyping(e.target)) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === '/') { e.preventDefault(); location.hash = '#ports'; setTimeout(() => $('#q')?.focus(), 0); }
    else if (e.key === 'r') tick();
    else if (e.key === 'Escape' && state.q) { state.q = ''; setHash(); render(); }
  });
  delegateSpotlight();
  // Observe EVERY .reveal in the document, not just the ones inside the tabs.
  // .reveal starts at opacity:0 and only becomes visible when .in is added, so
  // anything unobserved stays permanently invisible — the hero, the headline
  // and the section head all live outside #tab-services and would vanish.
  observeReveals(document);
  route();
  tick();
}
