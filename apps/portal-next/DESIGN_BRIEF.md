# Portal redesign — shared design brief (READ FIRST, obey exactly)

You are one of several agents enhancing an existing Vite+React+TS infra dashboard
in `~/stacks/apps/portal-next/web/`. It builds green today. Your job: raise the
quality of YOUR assigned files to a high bar, against this shared design system.
Stay inside your file ownership (below). Do NOT touch other agents' files,
`src/index.css` (owned by the lead — use its tokens), `package.json` (do not
`npm install`), or anything under `src/lib/*` except to import (they are correct:
`discover.ts`, `api.ts`, `data.tsx`, `panels.ts`, `accents.ts`, `theme.tsx`,
`icons.tsx`, `freshness.ts`, `links.ts`). Do NOT run `npm run build` or deploy —
typecheck only with `npx tsc --noEmit -p tsconfig.app.json`. If you need a
dependency that isn't installed, STOP and report it — do not install it.

## The subject & identity
A self-hosted dev-box **control panel** — the machine you monitor. It is a TOOL,
scanned and operated, not read. Identity: **instrument / telemetry**, cool and
precise. Committed dark-first (light theme still works via tokens). One confident
accent, spent only on primary/interactive things; everything else quiet. NO
rainbow gradient headline (it's a generic AI tell) — the running infrastructure
(the 3D rack) is the visual hero, not decorative type.

## Tokens (already defined in index.css — use via var(), never hardcode)
- Ground/surfaces: `--bg --bg-2 --surface --surface-2`; hairlines `--line --line-2`.
- Ink: `--ink` (primary) `--ink-2` (secondary) `--dim` (muted). Cool-grey, chosen.
- Accent (THE one): `--primary`. Use sparingly — interactive/emphasis only.
- **Status is RESERVED, semantic, separate from the accent**: `--ok --warn --down
  --unk`. Always paired with form (a dot/LED/pill/stripe) + a text label, NEVER
  colour alone. up=ok, starting=warn, down=down, unknown=unk.
- Panel chrome accents `--a1..--a6` (via `accentVar(key)`) — chrome only, never state.
- `--r` radius, `--mono` font. Use `font-variant-numeric: tabular-nums` on all
  aligned digits (counts, ports, stats).

## Shared utility classes (defined in index.css — reuse, don't re-invent)
- `.panel` — a surface card: header (`.panel-h`) + body (`.panel-b`). For a
  scrolling body use `.panel-b.scroll` (it sets max-height + overflow-y:auto with
  a thin styled scrollbar). This is how you fix mismatched panel heights.
- `.reveal` — opacity:0 until `.in`; the `<Reveal>` component adds `.in` on scroll.
- `.tag` (+ `.ok/.warn/.down/.public/.loopback`), `.dot[data-state]`, `.mono`,
  `.btn`, `.chip`, `.kbd`, `.tbl` (styled tables with sticky header + h-scroll wrap).
Add anything component-specific in a CO-LOCATED `.css` file you import from your
component (e.g. `Services.css`). Never edit `index.css`.

## Motion (deliberate — too much reads AI-generated; honour prefers-reduced-motion)
Use framer-motion (installed). Allowed & encouraged: route/page transition
(short fade+rise), staggered reveal of a section's children ON MOUNT ONCE (not on
every poll — reconcile by key), hover lift on interactive cards/rows, stat
count-up, `layout` animation when a filtered list re-orders. Keep durations
120–320ms, easing calm. No infinite ambient loops except the 3D's gentle idle.

## Data model (reuse; never re-fetch)
Everything comes from `useData()` (the `DataProvider` context in `src/lib/data.tsx`)
— one shared poll. Nodes are `PortalNode[]` (`src/lib/discover.ts`). Group with
`panelize()`. Icons via `iconFor`/the lucide map in `src/lib/icons.tsx`. NEVER
render container `Env`, `Mounts`, or `Command` (security).

## The 3D component contract (so it drops into Overview cleanly)
The three/ agent exports `<StackViewport />` — SELF-CONTAINED: it reads nodes from
`useData()` itself, needs no props, sizes to its parent (~70vh, contained, NOT a
tall scroll track), and renders a static fallback if WebGL/reduced-motion. Overview
just places `<StackViewport />`. Keep this interface stable.

──────────────────────────────────────────────────────────────────────────────
## File ownership (edit ONLY your set)

### Agent A — THE 3D (make it genuinely impressive; this is the centerpiece)
Owns: `src/components/three/*` (StackScene, StaticStack, webgl, + new files) and
a co-located `three.css`.
- Model REAL server racks: a chassis frame (dark metallic PBR), stacked 1U server
  slabs, each slab's front face with status **LED(s)** (emissive, status colour),
  vent slits, small port dots; rack rails; real depth. It must read unmistakably
  as a server rack. Top = an **edge/Traefik** slab labelled; one **rack per
  project/stack** (panelize); a container floor below.
- **Blend into the page**: `<Canvas>` transparent (`gl={{alpha:true}}`,
  `setClearColor(…, 0)` or scene bg = `--bg`), no jarring different-coloured box;
  wrap in a `.panel`-like framed viewport with a subtle vignette.
- **Interactive + data-rich**: hover a unit → drei `<Html>` tooltip (icon · name ·
  status label · host · image); rack shows its project name (drei `<Text>`/`<Html>`).
  Click a unit → `navigate('/services/:id')` (use react-router). Cursor pointer on
  hover.
- **No scroll-hijack**: a contained viewport with gentle auto-orbit + OrbitControls
  (drag rotate, wheel zoom WITHIN canvas only), and a small Edge/Projects/Containers
  focus selector. Lighting: key + rim + soft ambient; cheap bloom on the LEDs if
  affordable. Instance the container floor. Perf-capped; graceful static fallback.
- Colours strictly from the status/token CSS vars (read them via getComputedStyle
  or hardcode the SAME hexes as index.css and note it).

### Agent B — Services list, filters, cards/rows
Owns: `src/pages/Services.tsx`, `src/components/ServiceCard.tsx`,
`src/components/ServiceRow.tsx`, co-located `Services.css`.
- A dense, scannable manager view. Persistent filter bar: status chips × project ×
  kind × text search (combine; reflect counts). table⇆cards toggle + density,
  persisted (localStorage). Group-by-project collapsible. Scales to ~40 services
  with NO overwhelm — equal-height cards, tidy rows, clear status form (dot/stripe).
  Row/card → link to `/services/:id`. framer-motion `layout` on filter re-order,
  hover lift. Empty/'no match' state.

### Agent C — Detail pages (fix the mismatched-height problem)
Owns: `src/pages/ServiceDetail.tsx`, `src/pages/ProjectDetail.tsx`, co-located
`Detail.css`.
- A consistent responsive panel GRID (e.g. 12-col). Rows of panels are EQUAL
  height; any panel whose content overflows uses `.panel-b.scroll` (interior
  scroll) — this is the CVOps·S3 bug: no more sections of random size. Service
  detail: header (icon, name, status pill, open-in-new-tab), then panels —
  Endpoint/URL, Route (rule/provider/target/entrypoints), Ports (scrollable list),
  Container (image/state/health + labels list, scrollable) — NEVER Env/Mounts/
  Command. Project detail: health rollup + its services (reuse ServiceRow if handy)
  + its routes + ports. Breadcrumb back. Reveal-on-mount.

### Agent D — Overview, shell, motion, Topology, Ports/Routes pages
Owns: `src/pages/Overview.tsx`, `src/pages/Topology.tsx`, `src/pages/PortsPage.tsx`,
`src/pages/RoutesPage.tsx`, `src/components/AppShell.tsx`, `src/components/Reveal.tsx`,
`src/components/PortsTab.tsx`, `src/components/RoutesTab.tsx`, co-located CSS.
- Overview: summary-first — a health strip (up/total, projects, stacks, ports as
  count-up stat tiles), a "needs attention" list (anything down/orphaned) FIRST,
  then `<StackViewport />` (contained), then quick links. Reduce empty space; no
  giant hero. Route page transitions in AppShell (framer-motion, keyed on
  location). AppShell: refine sidebar/topbar (freshness pill, global search, theme,
  refresh) — quiet, precise. Topology: keep the SVG graph but polish (status-lit
  nodes, hover highlight, click→detail). Ports/Routes: the `.tbl` tables with the
  filter bar, sticky header, h-scroll wrap.

──────────────────────────────────────────────────────────────────────────────
Deliverable per agent: your files at a high bar, `npx tsc --noEmit -p
tsconfig.app.json` clean for the code you touched, a short report of what you did
and any cross-file assumption. The lead integrates, builds once, screenshots, and
deploys. Do not deploy. Do not leave debug/dead code.
