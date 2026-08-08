# Portal reorg — orchestration contract (round 2: "systems" model)

The Overview is being reorganised around **systems**. This brief is the contract
three agents build against IN PARALLEL on disjoint files. The shared foundation
(libs, one component, routing, the backend) is ALREADY DONE by the lead — agents
only COMPOSE it. Do not edit the shared files listed under "DO NOT TOUCH".

## The mental model

- A **system** = one compose group (`n.group`): a project (`tals`, `cvops`), a
  stack service (`monitoring`, `kafka`, `postgres`, `redis`, `wiki`, `mgmt`), or
  infra (`edge`, `portal`). One system → one card on the Overview → one domain
  page at `/systems/:group`.
- A **service** = one `PortalNode` (a routed container, an unrouted container, or
  an @file host process). Clicking a service opens `/services/:id` (UNCHANGED —
  `ServiceDetail.tsx`, do not touch).

## Shared foundation you MUST use (already built, importable)

`lib/discover.ts` — PortalNode now also has:
- `serviceType: ServiceType` (`'web'|'database'|'cache'|'queue'|'storage'|'observability'|'edge'|'runtime'|'other'`)
- `volumes: VolumeRef[]` (`{name, destination?}`) — named docker volumes it persists to
- `uptimeSecs: number | null` — parsed from container Status ("Up 3 hours")
- exports: `TYPE_META` (`Record<ServiceType,{label,order}>`), `serviceTypeOf`, `volumesOf`, `parseUptime`

`lib/systems.ts` — the rollup layer (pure):
- `System` interface: `{ key, title, kind:'project'|'stack'|'infra', accent, nodes, total, running, up, down, starting, unknown, hasRunning, uiLinks: UiLink[], volumes: VolumeRef[], newestUptime, oldestUptime }`
- `systemsOf(nodes): System[]` — sorted projects→stack→infra, then running desc
- `runningSystems(systems)` — hasRunning only (the Overview grid source)
- `dataOnlySystems(systems)` — stopped-but-has-volumes (the disk card's extra rows)
- `uiPorts(nodes): { stack: UiLink[], project: UiLink[] }` — browsable UIs split by scope
- `groupByType(nodes): TypeSection[]` (`{type,label,nodes}`, type-ordered) — the domain page sections
- `recentlyStarted(nodes, thresholdSecs=1800): PortalNode[]` — newest first (activity feed)
- `volumeSize(df,name)`, `systemDiskBytes(df,system)` — bytes from /system/df, or null
- `fmtBytes`, `fmtAgo`, `fmtUptime` — formatting helpers
- `UiLink`: `{ id, name, url, host, port, status, group, groupKind }`

`lib/favorites.ts` — `useFavorites()` → `{ favs:Set<string>, isFav(key), toggle(key) }`; `favFirst(items, keyOf, favs)` (fav-first stable sort). Keys are system keys (`system.key`).

`lib/api.ts` — `usePortal().data.df: SystemDf | null` now available (`{Volumes,Images,Containers,LayersSize}`, each entry has sizes; null if unavailable — degrade gracefully to "no sizes").

`components/SystemCard.tsx` — `<SystemCard system={s} isFav={bool} onToggleFav={fn} />`. Fully styled + links to its domain page. Overview MUST use this for the system grid (do not re-implement the card).

`lib/icons.tsx` — `<ServiceIcon node={n} size/>`, `<StatusIcon status showLabel/>`, `<TypeIcon type={serviceType} size/>`, `TYPE_ICON`, `STATUS_VAR`.

`lib/links.ts` — `systemLink(group)`, `serviceLink(node)`. `lib/data.tsx` — `usePortal()`, `healthOf`, `needsAttention`.

Design tokens (index.css, already global): `--ink --ink-2 --dim --primary --surface --surface-2 --line --line-2 --ok --warn --down --unk --a1..--a6 --r`. Global health bar: `.ov-bar` with `.seg.up/.starting/.down/.unknown`. Use `color-mix(in srgb, var(--acc) N%, …)` for accent tints. Everything is theme-aware (light+dark) already via tokens — never hardcode hex for text/surfaces.

## DO NOT TOUCH (lead owns these — editing them causes merge conflicts)
`lib/*.ts(x)` (discover, systems, favorites, api, data, links, icons, accents, panels, freshness, useProbe, theme), `components/SystemCard.*`, `components/AppShell.tsx`, `App.tsx`, `main.tsx`, `index.css`, `pages/ServiceDetail.tsx`, `components/ServiceCard.tsx`, `components/ServiceRow.tsx`, `components/PortsTab.tsx`, `components/RoutesTab.tsx`, `pages/Services.*`, `pages/RoutesPage.tsx`, `pages/PortsPage.tsx`. The backend (`apps/portal/compose.yml`, `edge/dynamic/portal-api.yml`) is DONE.

Rules for all agents: TypeScript strict (no `any` without reason, no unused vars — `tsc --noEmit` must pass). Respect `prefers-reduced-motion`. Keep bundle sane. Match the existing house style (see any current page). Icons: lucide-react ONLY, never emoji.

---

## AGENT A — Overview rewrite  (OWNS: `pages/Overview.tsx`, `pages/Overview.css`)

Rebuild the Overview as a manager's mission-control, top to bottom:

1. **Quick links strip (top-upper).** A prominent horizontal strip of the most-used
   web UIs, Docs + Grafana FIRST and visually primary, then Prometheus, Dozzle,
   Portainer, Traefik, Kafka UI (pull from `data.nodes` browsable UIs by
   host/name; Docs and Grafana are guaranteed anchors built with `hostUrl()` —
   port-based links on the current hostname, since names are dormant). Each opens in a new tab. This is the first thing on the page.
2. **Needs attention** — keep the existing behaviour (down/orphan via `needsAttention`);
   collapse to a slim "all clear" when empty.
3. **Systems grid** — the centrepiece. `runningSystems(systemsOf(data.nodes))`,
   ordered fav-first (`favFirst` + `useFavorites`), each rendered with `<SystemCard>`.
   Above it: a **card quick-filter** (live text input over system title/key) + a
   small status segment (All / Running clean / Has issues) that filters the cards.
   Show a count ("6 systems · 4 pinned"). Empty state when filter matches nothing.
4. **Open UI ports card** — `uiPorts(data.nodes)`; TWO columns, "Stack UIs" and
   "Project UIs". Each row: status dot, name, host (or `:port`), open ↗. This is
   the "what can I open, split stack vs project" card the user asked for.
5. **Data & disk card** — every system's volumes with sizes from `data.df`
   (`systemDiskBytes`/`volumeSize` + `fmtBytes`); include `dataOnlySystems` (stopped
   things that still hold data — explicitly NOT in the systems grid above). Show a
   total (LayersSize/images if you like). If `df` is null, show volume names/counts
   without sizes and a subtle "sizes unavailable" note.
6. **Recent activity** — `recentlyStarted(data.nodes)`; small feed "X started 3m ago"
   with service icon + link to `/services/:id`. Hide the section if empty.
7. Keep the both-APIs-down fallback (KNOWN_HOSTS) that exists today.

Use `Reveal` (`components/Reveal.tsx`) for scroll-in like the current page. The 3D
scene is GONE from here (it moved to Topology). Make it genuinely usable and
scannable — a manager should answer "is everything ok, what's running, what can I
open, how much disk" in one glance.

---

## AGENT B — System domain page  (OWNS: `pages/ProjectDetail.tsx`, `pages/Detail.css`)

This is where a system card lands (`/systems/:name`; route already wired, param is
still `name`). Rework the existing ProjectDetail:

- Breadcrumb reads **Systems** (link to `/` ) → system title. Header: title, kind
  badge, `up/total up · N ports · N routes · N volumes`, health rollup (keep).
- **Services split by type.** Use `groupByType(nodes)` to render a section per
  `ServiceType` (icon via `<TypeIcon>`, label, count). Within a section list
  services (reuse `ServiceRow` in a table, or cards — your call, keep it clean).
  Clicking a service → `/services/:id` (via `serviceLink`, ServiceRow already does).
- **Type + status filter chips** at the top of the services area: one chip per type
  present (with counts) + status chips (up/starting/down/unknown), combining, with
  a Clear. Same interaction feel as `pages/Services.tsx`'s filter bar.
- **Data section** — this system's volumes with sizes (`systemDiskBytes`,
  `volumeSize`, `fmtBytes` from `data.df`); mount destinations if useful.
- Keep the Routes and Ports panels that exist today.
- Empty/unknown-system state (keep the current "No such system" guard, reworded).

Reuse `PortsTab`, `RoutesTab`, `ServiceRow`, `useProbe` (all read-only for you).

---

## AGENT C — 3D Topology, upgraded  (OWNS: `pages/Topology.tsx`, `pages/Topology.css`, `components/three/StackScene.tsx`, `components/three/three.css`, `components/three/StaticStack.tsx`, `components/three/webgl.ts`)

Move the 3D fly-through here and make it the star, MUCH richer per the user:

- **Topology page** becomes the 3D scene, large (fill the content height, e.g.
  `min-height: calc(100vh - ~140px)`), not a small framed viewport. Keep the focus
  buttons (Edge/Projects/Containers) and legend. Keep the current 2D SVG graph as an
  OPTIONAL "Flat map" toggle beneath or behind a segmented switch (nice-to-have, not
  required) — or drop it if it complicates; reduced-motion/no-WebGL still falls back
  to `StaticStack`.
- **Connection cables.** Draw visible 3D cables/links: edge → each rack (project),
  and rack → the container floor. Use tube/line geometry with a subtle animated
  energy pulse flowing along them (respect reduced motion — static if reduced).
  Colour by the downstream node's status. This is the headline ask.
- **Labelled + designed containers.** Every unit/slab and floor cube gets a readable
  name label (drei `<Html>` or `<Text>`), a per-service type/icon treatment, and more
  surface detail. The container floor cubes should read as little labelled machines,
  not anonymous blocks.
- **Richer, more-lit servers + edge.** Add detail to the rack slabs and the edge bar
  (more geometry: bezels, handles, vents, indicator arrays), raise overall lighting a
  notch (brighter key/fill, a bit more ambient, tasteful bloom/emissive), and give the
  edge node clearly more presence/detail. The user asked specifically for "way way
  more details" and "a little bit more light", including on the edge.
- Keep it 60fps-ish: instance where possible, cap detail (MAX_UNITS), lazy-load stays
  intact. Keep pan (shift/ctrl-scroll), orbit, click-to-open behaviour.

`StackScene.tsx` currently exports `StackViewport` and `StackScene` (back-compat). Keep
BOTH exports working. Topology should mount the big scene (you may add a `fill`/size
prop or a dedicated `TopologyScene` export — your call, keep exports back-compat).
Read `components/three/webgl.ts` for `statusHexes/STATUS_HEX/cssVar/hasWebGL/prefersReducedMotion`.
