# Plan: all fourteen open issues, in the order they should be done

_Written 2026-08-19. Status: proposed. Covers #89–#105, every issue open at
`v2026.8.1` / `25d6ef4`._

This is the master plan. Each of the five existing plans in this directory is
narrower and older; where they disagree with this one on ordering, this one is
later. Where they disagree on **design**, they win — `control-and-settings.md`
in particular already decided things this plan only schedules.

Everything below was measured on the live box before it was written. Numbers are
observations, not estimates, and the ones that surprised us are called out as
such, because a plan whose premises are wrong is worse than no plan.

---

## 0. The five findings that changed the plan

Investigation turned up five facts that reorder the work. They are here rather
than buried in their sections because each one makes something cheaper or more
dangerous than the issue that describes it assumes.

**1. An SVG already renders in the docs reader. Verified, today, in a browser.**
A markdown file containing `![x](brand/wordmark-dark.svg)` renders as a real
`<img>` — the CSP's `img-src` already reaches `:8100`, and `content_policy()`
already serves `.svg` inline. This is the whole security question in #103,
answered by accident: **mermaid does not need a runtime renderer.** A build step
that turns the seven committed diagrams into committed `.svg` files makes them
render with zero new code, zero new dependency in the SPA, and no relaxation of
the property that makes `md.tsx` safe — that it builds React elements and never
an HTML string. Runtime mermaid remains an option; it is no longer the only one.

**2. cAdvisor is 52% of the entire TSDB, and ~90% of that is series nothing has
ever queried.** 4147 series, of which 407 are reachable from any dashboard,
panel or alert in this repo. cAdvisor runs with `Config.Cmd = null` — every
default metric family on, `--housekeeping_interval` at 1s, container labels
stored wholesale. #92 is framed as "replace Prometheus"; the measurement says
the server is at 28% of its memory cap with zero restarts and the cost is disk,
half of which is one misconfigured exporter. **Configure before replacing.**

**3. `guard.py` does not contain `portal-socket-proxy`, and a comment in
`apps/bothy/compose.yml` says it does.** #97 says the rename touches two safety
allowlists; it touches `actions.ts`'s `SELF` map and `test_guard.py`'s *negative*
list. The real hazard is that `SELF` is an exact-match lookup on the live Docker
name, so a rename **fails open silently** — the warning before an action that
takes the page down simply stops appearing. The rename must land as
double-accept first, flip second.

**4. `System.key` IS `n.group`.** It is the URL parameter, the accent seed, and
the panel key. #93 proposes letting a user regroup services; done naively that
rewrites every bookmark and reshuffles every colour. Grouping needs a stable
identity that is not the display grouping.

**5. Adding `--brand` to `:root` makes it a required token automatically — and
two things are broken that would make that go badly.** `themeDraft.GROUPS` gates
which tokens get a form field, so an ungrouped required token makes the editor
report one failure and return early, hiding every other finding with no field to
fix it. And `theme-contract.mjs:240` merges `BASE` into each theme before
checking completeness, which makes the "declares every required token"
assertion **vacuous for every shipped theme file**. Both are pre-existing;
#98 is the thing that would step on them.

---

## The areas

| Area | Issues | Theme |
|---|---|---|
| **A. Tell the truth** | #105, #97, #92 | The box's own reports are wrong or expensive. Nothing built on top of them is trustworthy until they are not. |
| **B. The reading surface** | #103, #94, #89 | Files and docs — the most-used screen, and the one with a live bug. |
| **C. The control tier** | #93, #91, #90 | Grouping, then running, then a shell. Strictly in that order. |
| **D. The front door** | #100, #104, #96 | How someone who is not the author gets in. |
| **E. Brand and settings** | #98, #95 | A decision, then a design pass that depends on it. |

Areas A and B are independent and can run in parallel. C depends on nothing but
must be internally ordered. D depends on A finishing (the README should not
document a rename that has not happened) and on C's shape being settled enough
to describe. E is last: #95's copy uses vocabulary #96 settles, and #98 may add
a row to the panel #95 redesigns.

---

# Area A — Tell the truth

Three issues that share one property: **the box currently reports something
false, and a person has learned to ignore it.** That is the most expensive
failure mode this repo has; `doctor.sh`'s own comments name it as cry-wolf in
three separate places.

## A1 · #105 — `just doctor strict` on a fresh box

Four faults, all true statements about a new box rather than defects. All four
are the same principle — already written into `doctor.sh` at lines 35-40, 50-52
and 116-118 — not yet applied to four more cases. `dim()` already exists for
exactly this third state.

| fault | fresh | broken | rule |
|---|---|---|---|
| no postgres backups | zero files, box younger than one backup period | files exist but stale/tiny/incomplete | `red` only if `[ -z "$latest" ] && uptime > 86400` |
| kubectl missing | absent, no cluster ever claimed | present and nodes not `Ready` (already handled) | **never** a fault — minikube retired 2026-08-12, nothing depends on k8s. Unconditional `dim` |
| docker-daemon target down | no `metrics-addr` in daemon.json; bootstrap warns and does not set it | `metrics-addr` present and still down | `red` only if `grep -q metrics-addr /etc/docker/daemon.json` — or delete the job entirely, see A3 |
| prometheus self-scrape down | `health` is `unknown`, seconds after start | `health` is `down` with a `lastError` | distinguish `unknown` from `down`; gate on `now - lastScrape > 3 × scrape_interval` |

**The single highest-value line in this issue** is not any of the four: it is
that `doctor.sh:86` throws away `lastError`, `lastScrape` and
`lastScrapeDuration` from an API response that already contains them. Printing
`lastError` turns `prometheus (down)` into a line a reader can act on, and it
separates fresh from broken for two of the four faults at once. Do that first,
even alone.

Also fold in: `doctor.sh:184-193` does not exclude the `postgres` maintenance
database from the backup-coverage comparison, and `upgrade.yml:214-218` does,
with a comment explaining why. Two copies of one rule, already divergent.

**Done when** `install.yml:229-247` flips from `just doctor` to `just doctor
strict` and the comment explaining the downgrade is deleted rather than edited.
That comment is the acceptance test.

## A2 · #97 — rename `portal-socket-proxy` → `bothy-socket-proxy`

Small, and dangerous in one specific way. Three functional references
(`container_name`, the Traefik `url:` that dials it by Docker DNS, and
`actions.ts`'s `SELF`), one test, fourteen prose mentions.

**The hazard, stated plainly:** `SELF` is keyed on the live container name and
the SPA is a *built artifact*. During any rename there is a window where the
daemon has the new name and a browser holds the previously-built bundle. In that
window `consequenceOf()` returns `{selfAffecting: false}` — no warning, no
error, just a missing sentence before an action that blinds every page. It fails
open. `doctor.sh:54`'s `expected` list has the mirror-image window.

**Therefore, three commits, in this order:**

1. **Double-accept.** `SELF` carries both keys with the same message;
   `test_guard.py:152` lists both; `doctor.sh:54` accepts either for this one
   name. Nothing renames yet.
2. **Flip.** `container_name` and `edge/dynamic/portal-api.yml:151` change in
   the *same commit* — a `docker compose up -d --force-recreate` of the
   `socket-proxy` service in project `bothy`. Traefik's file provider watches
   `./dynamic`, so no restart, but the two must move together or
   `/-/api/docker/containers/json` 502s and the whole Overview enrichment goes
   blank. Afterwards verify socketnet still holds **exactly two** members — that
   two-member blast radius is the only control on a proxy with no auth.
3. **Drop the legacy key**, once a rebuilt `portal-next` image has shipped.

**Fix while in there,** because they are wrong today: `apps/bothy/compose.yml:40-46`
claims the name is in `guard.py` (it is not — `guard.py:102-110` explains at
length why it deliberately is not), and `CONTRIBUTING.md:217` /
`docs/ARCHITECTURE.md:333` still say the proxy lives in `apps/portal`, a
directory deleted 2026-08-18.

## A3 · #92 — the monitoring stack's weight

Measured: monitoring is 954 MiB of 2010 MiB total (47.5%, the issue's claim
confirmed). But the largest single consumer on the box is **keycloak at 642 MiB**,
and Prometheus is at 299 MiB of a 1g cap with zero restarts. The RAM story and
the disk story are different problems and the issue conflates them.

**Do these three, in order, and stop:**

1. **Configure cAdvisor** (the one option with no functional loss). Give it a
   `command:` restricting metric families to `cpu,memory,network`, add
   `--docker_only=true`, `--store_container_labels=false` with
   `--whitelisted_container_labels=com.docker.compose.project,com.docker.compose.service`,
   and slow `--housekeeping_interval`. Ceiling on the win: **4147 → ~407 series,
   −90%.** Every existing query still resolves, *including* the
   `container_label_com_docker_compose_project` selector that `SystemDialog.tsx`
   depends on and which nothing else on the box can produce.
2. **Drop the `docker-daemon` scrape job.** Zero consumers repo-wide, 532
   samples/scrape, and it is one of #105's four faults. Keep
   `host/docker/daemon.json` — it also carries log rotation — and drop only the
   job. `prometheus.yml`'s own comment about the retired redis/kafka jobs
   already makes this argument.
3. **Consider `--storage.tsdb.retention.size`.** 1.9 GB over 15 days ≈ 127
   MB/day, and (1) roughly halves that. Nothing in-product reads past 24h —
   `Vitals.tsx`'s longest range. Retention beyond ~2 days serves ad-hoc Explore
   only.

**Do not replace Prometheus.** Three consumers speak native PromQL over
`/api/v1/query_range` (the portal's `metrics.ts`, Grafana's `prometheus`
datasource uid, three alert-rule expressions) and a fourth reads
`/api/v1/targets`. Any replacement must serve both or all four break — and the
cost being addressed is 52% one exporter's misconfiguration. Revisit only if (1)
lands and the footprint is still wrong.

**While in there:** `README.md:206` says six provisioned dashboards. There are
four. There is no Loki dashboard and no consumer of `engine_daemon_*` anywhere.

---

# Area B — The reading surface

## B1 · #94 — Files opens on the wrong root (**a live bug, fix first**)

`Reader.tsx:118-146` picks the first *writable* root — `notes`. `Files.tsx:340-360`
still uses `r.roots[0]` — `home`, which is the worst possible default listing.
Two components, one concept, already disagreeing. This is a bug fix that happens
to sit inside a feature issue; it should not wait for the feature.

The feature — "Your files" as the landing root, and a quick view for Bothy's own
docs — then builds on one shared root-choice function rather than a third copy.

## B2 · #103 — the docs reader should read like docs

Three parts, now cheap in a way the issue did not know:

- **Type and measure.** Mechanical. `--read-measure: 72ch` and `--read-fs` at
  16px already exist; the reader needs to use them rather than the app's
  1320px layout width. Prose wants ~65–75 characters; a dashboard does not.
- **Images.** Already shipped, with 26 render tests behind them.
- **Diagrams — take the build-step path.** Finding (1) above: commit
  `docs/assets/*.svg` generated from the seven mermaid blocks, reference them as
  ordinary images. Zero SPA code, zero dependency, and `md.tsx`'s
  "React elements, never an HTML string" property is untouched. A `just` recipe
  and a CI check that the SVGs are not stale is the entire delivery. Runtime
  mermaid stays available for user-authored diagrams later, as its own issue,
  with its own security argument.

## B3 · #89 — the edit component

Mostly already done and mis-scoped. `CodeSurface.tsx` is a clean controlled
CodeMirror 6 component with exactly **one** consumer. The issue reduces to
letting `ThemeEditor.tsx:316-335` — a bare `<textarea>` — mount it instead.
Vim mode was explicitly declined in `CodeSurface.tsx:32-33` and that decision
stands until someone re-argues it; it should come out of this issue's scope
rather than sit in it unremarked.

---

# Area C — The control tier

Three issues that look independent and are strictly ordered. #90 and #91 are the
same "command allowlist" proposal arriving from two directions, and #93 changes
the identity both would key off.

## C1 · #93 — group services the way you think about them

**First, because it changes a primary key.** `System.key` IS `n.group` — the URL
param, the accent seed, the panel key. Any user-facing regrouping must introduce
a stable identity separate from the display grouping, or bookmarks break and
every accent reshuffles.

`classify()` has 3 call sites; `groupKind` has 7 consumers. And there is a live
inconsistency to fix on the way in: **`allPorts()` ignores the
`dev.portal.group` label override that `makeNode()` honours.** One of them is
wrong today.

Watch the trap this box has already been bitten by once: compose project names
are global to the daemon, so adopting a project name as an identity picks up
whatever else claims it.

## C2 · #91 — start any service from any compose file

`docs/plans/control-and-settings.md` already decided the hard part and it should
be quoted rather than re-litigated: **do not parse compose to do it.** That plan
pre-authorises a safe "Layer 2 — Run". This issue is that layer, scoped to
declared intent — `apps/portal-collector` already reads each project's
`project.dev.yml` and reconciles declaration against host truth.

`guard.py:39` `VERBS = ("restart","stop","start")` is the seam. Extending the
verb set is the small part; the executor is the large part, and it is the same
executor #90 needs.

## C3 · #90 — a real shell in the browser

Last, and treated as a design decision rather than a feature. The pieces are
already in place *and deliberately disconnected*: the `shell` role is defined,
described in `ROLE_MEANING`, granted to nobody by `keycloak-init`, and gated on
**zero routes**; `EXEC=0` on **all three** socket proxies, not two — the
portal's read-only one plus `bothy-control`'s read/write pair; `CONTAINERS=0` on
the write proxy. Step-up auth is written but unbuilt: the realm carries
`acr.loa.map` and `auth/compose.yml:257-274` writes out the five steps that
would enforce it, including the second oauth2-proxy instance it needs.

A shell needs exactly the combination this architecture exists to prevent. That
is not an argument against it — the user's position is explicit and stands: *"its
a real devbox tooling, like arch linux — we give instructions and warnings."*
It is an argument that the change is to the **threat model document first**, and
the code second.

**The document half has landed.** `SECURITY.md` now carries *A shell in the
browser (#90), before it exists* — the current boundary with file:line, what
each of #90's three shapes would cost, the four-step path from a widened proxy
to host root, the conditions under which "it grants no new capability to the
person it is for" is true, and a ten-item mitigation checklist the code PR is
held to. Three findings from writing it that change the shape of the code work:

- **`guard.SEVERING` cannot survive a real PTY.** #90's requirement that you
  must not be able to stop the container serving the page you are typing into is
  met by shape 1 (allowlisted commands) and by no other shape. State that in the
  issue rather than discovering it in review.
- **Shape 2 — "a PTY in a throwaway container" — is the most expensive, not the
  safest.** Creating that container needs `POST=1` *with* `CONTAINERS=1`, which
  is `/containers/create` with a bind mount of `/`. Prefer shape 1, and if a real
  terminal is wanted, go straight to shape 3 (host PTY as the operator's own
  account), which needs no socket grant at all.
- **Step-up auth is the non-negotiable that the issue does not ask for.** The
  honest argument for the feature is that the operator already has SSH; the gap
  is that SSH is a tailnet key and the shell is a browser cookie. Step-up is what
  closes that gap, and it is the only mitigation here that is real work.

---

# Area D — The front door

## D1 · #100 — `scripts/bothy.sh`, the curl-able installer

`scripts/bothy` exists, is bash-3.2-clean, and `cli-commands.sh` checks both
directions of its dispatch table. **`scripts/bothy.sh` does not exist at all** —
so the CLI is reachable only by already having the repo, which is precisely the
chicken-and-egg its own header says it exists to break.

**One open design question, and it should be answered before #96 is written:
how does the installer verify what it fetched?** The `v2026.8.1` release has
zero assets. Three shapes:

- **(a) attach assets** — extend `just release` or add a workflow that uploads
  `bothy.sh` + `.sha256`. Verifying an asset against a checksum from the same
  release is weak; the strong form pins the checksum *inside* `bothy.sh` and
  documents `curl -o` + review as the primary path.
- **(b) verify the tarball** — GitHub's auto-generated tarballs are not
  byte-stable across git versions. This has bitten other projects. Avoid.
- **(c) clone at the tag, verify a pinned commit SHA.** **Recommended.** No
  release plumbing at all, and `init` already requires `git`.

Constraints: bash 3.2 (`${var,,}` is a *parse* error on macOS), shellcheck-clean
(warnings are fatal here), never `sudo`, never write outside `$HOME`. Extend
`cli-commands.sh` or add a sibling so the pinned version cannot drift from
`VERSION` — the same class of check `version.sh` already does for the tag. And
`install.yml` should gain a row that installs *via the installer*, since that job
already exists and is green.

## D2 · #104 — the README

**Half done and should be re-scoped rather than closed.** The wordmark header
landed; the social preview is uploaded and live (the rendered page serves a
`repository-images.githubusercontent.com` og:image — `gh api
.open_graph_image_url` returns null and is unreliable). A hardcoded tailnet IP
came out in the same commit.

Remaining, all from #104's own stated scope:

- Quick start is at **line 155**, behind two essays. The issue says lead with the
  screenshot and the one-command install; it is true now, so lead with it.
- "What you get" is **entirely absent**: zero occurrences of "theme", zero of
  "exec". Roles appear only inside the deep SSO section. Bothy Control appears
  only in a screenshot's alt text; Bothy Config not at all.
- Repo map is stale: `scripts/` is described as "`backup.sh` and `doctor.sh`"
  (there are eight plus the CLI plus `scripts/checks/`), and it omits
  `apps/bothy-config/`, `apps/bothy-control/`, `apps/portal-collector/`. No
  mention of `VERSION`, the release, or the CLI anywhere.
- Router counts disagree between README (10) and ARCHITECTURE (7), and `just
  verify` guards only the zero-`Host()` invariant, so the number is unguarded
  prose. Either guard it or stop printing it.

`docs/assets/files.png` staleness stays out of scope — that is #99.

## D3 · #96 — the documentation corpus

**After D1 and D2**, so "Installing" can document the curl path as it actually
ships and hang off a README structure that has settled.

Five gaps a new user hits, none of which any existing document covers:
installing (the best getting-started text that exists is the GitHub release
notes, which are *not in the repo*); the YAML you will actually edit; operating
it from the UI (**the largest hole** — the Control tier's verbs and the
deliberate absence of `exec` are documented only in `just urls`' output);
roles (three disagreeing sources: `me.ts`'s `ROLE_MEANING`, README's router
table, `realm-devbox.json`); and themes.

Shape: a new `docs/guide/` tree, each page linking *down* into existing
reference docs rather than restating them. Reuse README §SSO, README §"things
that will catch you", `docs/ARCHITECTURE.md`, and
`docs/brand/foundations/theming.md`. **Do not touch `docs/kb/`** — it is
correctly scoped as one machine's history and is not user documentation.

This is also the real test of B2's work: `apps/portal-files/compose.yml` makes
`docs` its own `safepath.ROOTS` entry, and the reader has only ever been
exercised against `docs/kb` and `~/claude-notes`.

---

# Area E — Brand and settings

## E1 · #98 — the brand green as a token

**Decide before building.** The issue frames this as "a rule so a new theme
cannot forget it"; the investigation says that rule cannot work as written, and
that the repo has already implicitly chosen the other option twice.

Correction to the issue's premise: `stray-colour.mjs` would **not** refuse a
literal here — it exempts `index.css` in full, because that is where the palette
lives. What argues against a literal is the design rule, plus the fact that an
unmeasured green will fail contrast against at least one of five palettes with
nothing to catch it.

And the committed artwork already hardcodes the **accent**, not a green:
`wordmark-dark.svg` carries one `#60a5fa` (Bothy Dark's accent),
`wordmark-light.svg` one `#2563eb`. There is no green anywhere in the brand
assets.

If Option 2 (`--brand`) is chosen it is a **~12-file change**, and two
pre-existing blockers must be fixed *first*:

1. `themeDraft.GROUPS` — an ungrouped required token makes `evaluateTheme`
   return early at `contract.ts:233`, reporting one failure, hiding every other
   finding, with no form field to fix it.
2. `theme-contract.mjs:240` merges `BASE` in before checking completeness, so
   the "declares every required token" assertion is vacuous for every shipped
   theme. The three theme files would silently inherit the base green and CI
   would stay green. Declaration must be asserted against `b.toks`, separately
   from measurement against the merged set.

Plus a migration cost the issue does not mention: every user theme already on a
box becomes "incomplete" the moment `--brand` is required. Runtime rendering is
unaffected (inheritance), so this is editor-only — but it is user-visible.

Note if a rule is added: the OKLCH hue-band accent rule must **not** apply to
`--brand`. A brand green sits at ~145°, inside the arc that rule forbids.

**Recommendation:** Option 1, written down. The artwork has already chosen it;
what is missing is the decision recorded in
`docs/brand/foundations/colour.md`, not a token.

## E2 · #95 — the Settings design pass

**Last.** #96 settles the vocabulary its copy should use, and #98 may add a
brand row to the panel this redesigns.

More of #95 already exists than it claims: "show the role you actually hold and
what it lets you do" is done (`RoleRow`, `ROLE_MEANING`, glyph + word + colour,
never colour alone), and the theme creator is already a full page — what sits in
the list is only its entry point.

Load-bearing constraints, from the page's own header: it is **read-only by
design, not by omission** — no greyed-out "coming soon" controls, because a
write path is a threat model. Appearance is the one exception, and only because
it writes one localStorage key in this browser. Colour is never the only
encoder. Any colour added must come from a token; `stray-colour.mjs` scans
`Settings.css` and is not exempt — which is why the five swatch hexes live in
`picker.css`, after sitting here for exactly one commit and breaking the check.

**The cheapest real win, independent of everything else:** the `Storage` panel
has no row for custom theme *files on disk*. `STORES[0]` says theme →
localStorage; that a custom theme is a `.css` file under
`apps/portal-next/data/themes/` appears only as prose in the Appearance lede.
That is the one factual gap in #95's "say where each setting lives" ask, and it
is a four-line change.

Cosmetic: `Settings.css:125-129` is a stranded comment and three blank lines
where the swatch rules used to be.

---

# The order, as one list

1. **#105** — `doctor.sh` prints `lastError`; four faults become `dim`. *(A1)*
2. **#92 step 1–2** — configure cAdvisor, drop the `docker-daemon` job. Step 2
   removes one of #105's four faults, so these two land together. *(A3)*
3. **#94 bug half** — one root-choice function, both consumers. *(B1)*
4. **#97** — double-accept, flip, drop legacy. Three commits. *(A2)*
5. **#103** — type and measure; diagrams via a build step. *(B2)*
6. **#89** — `ThemeEditor` mounts `CodeSurface`; drop vim from scope. *(B3)*
7. **#93** — stable identity before display grouping; fix `allPorts()`. *(C1)*
8. **#100** — decide verification (recommend clone-at-tag + pinned SHA), write
   `bothy.sh`, add the install-job row. *(D1)*
9. **#104** — re-scope, then lead with the install and add "what you get". *(D2)*
10. **#91** — the executor, on declared intent, not parsed compose. *(C2)*
11. **#96** — `docs/guide/`, after the front door has settled. *(D3)*
12. **#98** — decide. If Option 1, one paragraph in `colour.md` and close. If
    Option 2, fix both blockers first. *(E1)*
13. **#95** — the `STORES` row now; the design pass after #96. *(E2)*
14. **#90** — `SECURITY.md` first, code second. *(C3)*

Two items can start immediately and in parallel with anything: the `lastError`
line in #105, and the `STORES` row in #95. Both are small, both are independent,
and both make something that is currently wrong correct.

## What this plan deliberately does not do

- **Replace Prometheus.** The measurement says the problem is one exporter's
  configuration, and four consumers speak native PromQL.
- **Add runtime mermaid.** A build step delivers the seven committed diagrams
  without touching the property that makes the renderer safe.
- **Add vim mode.** Declined in `CodeSurface.tsx:32-33`; it needs a fresh
  argument, not an inherited scope line.
- **Rewrite `docs/kb/`.** It is one machine's history, correctly scoped.
- **Build a shell before the threat model changes.** The capability is wanted
  and will be built; the document that says why the box is safe has to say it
  about the box that exists.
