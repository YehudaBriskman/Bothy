# Plan: Bothy takes over its own stack

_Written 2026-08-17. Status: phase 1 not started._

Two moves, in order, each of which ends with a third-party container being
**deleted** rather than merely unused:

| Phase | Bothy gains | The box loses |
|---|---|---|
| 1 | full-text search + link navigation in **Bothy Files** | `docs` + `docs-sync` (MkDocs), port 8085, a mirrored copy of every `~/` markdown file inside this repo |
| 2 | **Bothy Control** — container start/stop/restart | `portainer` + `dozzle`, ports 9000 and 8080, two credential stores outside Keycloak, one read-write docker socket |

The order is not arbitrary. Phase 1 is small, has no new security surface, and
retires a service whose replacement already exists. Phase 2 is the first thing
on this box that can *change the state of another container*, and it should be
built by someone who has just spent a week in the editor tier's authorisation
code.

**The standing rule for both phases:** nothing is deleted until the thing that
replaces it demonstrably does the job. "We could delete X" is a hypothesis;
`just verify` passing with X gone is the evidence.

---

## Phase 1 — Bothy Files earns the docs site's job

### Why the docs site goes

It is not about the 84 MB. `apps/docs` keeps a **4.7 MB mirror of every markdown
file under `~/`** inside this repository's working tree. `apps/docs/sync.sh`
records the near-miss in its own header: `claude-notes/machine/credentials.md`
holds live passwords, it was being mirrored in, and the only thing between it
and a **public** repo was one `content/` line in `.gitignore`. The exclusion was
added and `--delete-excluded` cleaned up the copies, and that is a fix. Deleting
the mirror is a *class* fix — there is no copy to leak, no exclusion list to
keep correct, and no second place a file can be stale in.

The rest is real but secondary: an 18-second rebuild and a 15-second rsync loop
over three trees, one more image, one more published port, and a view of the
docs that is always a little behind the file.

### What genuinely goes missing, and must be built first

Measured against the running service, not guessed:

1. **Full-text search.** `portal-files` serves `/healthz /roots /tree /read
   /history /repos /status /git/diff /raw /archive`. There is no way to find a
   string across the notes. MkDocs' search box is the function you would miss on
   day one.
2. **Cross-document navigation.** `md.tsx` renders repo-relative links as inert
   text on purpose — it cannot resolve them, and `javascript:` must never become
   an `href`. So the wikilinks that `~/claude-notes` is built around do not
   click. MkDocs resolved them.

Not missing, and worth stating so nobody rebuilds them: admonitions, footnotes,
permalink anchors and mermaid. The `md.tsx` subset is deliberate and the Source
toggle is one click away. If a mermaid diagram is wanted later it is its own
decision, not a blocker for this phase.

### 1.1 `/search` in `portal-files`

**Files:** `apps/portal-files/app.py`, `apps/portal-files/checks/`

**The one design rule:** the search walk goes through `safepath.collect()`.
That function's docstring already argues this — `listing()` doing its own
`os.walk` was "correct, but a PATTERN, and a second implementation can copy a
pattern incorrectly". A search endpoint that walks the tree itself is exactly
where a forgotten `resolve()` puts `.env` into a result snippet. `collect()`
takes its limits as arguments precisely so a second consumer can have different
ones.

```
GET /search?root=<key|*>&path=<subtree>&q=<literal>&case=<0|1>&glob=<*.md>&limit=<n>
```

- `root=*` means every declared root **except `home`**. `home` overlaps `stacks`
  and `notes`, so including it returns every hit twice under two names. This is
  the same reasoning that already keeps `home` out of `WRITABLE_ROOTS`.
- The query is a **literal**, not a regex. A user-supplied regex is a CPU denial
  of service on a 3,000-file tree and buys little for prose search. Revisit only
  with a timeout-per-file, never by just passing it to `re`.
- Content match and filename match in one response, kept as separate arrays. The
  explorer's existing filter is a name filter; the two must not be conflated in
  the payload or the UI cannot label them honestly.
- Skip binary (`is_binary()` already exists) and anything over `MAX_BYTES`.

**Bounds, all four reported in the response rather than applied silently** — the
repo's own "no silent caps" rule:

| Bound | Value | Why |
|---|---|---|
| wall clock | 10 s | the walk budget `collect()` already models |
| files scanned | 20,000 | above this the answer is "narrow it", not a partial truth |
| matches | 500 | the browser renders every one |
| per file | 20 matches | one generated file must not fill the page |

The response carries `truncated: {reason, scanned, elapsed}` when any bound
bites. A result list that quietly stops is worse than an error.

**Checks** (`apps/portal-files/checks/`, wired into `just files-check`):
- a `search_denied.py` that plants a string in a file the policy denies
  (`.env`-shaped name, a `home` top-level dot entry, something under `.git`) and
  asserts the hit **never appears**. This is the check that matters; everything
  else is behaviour.
- role enforcement: `/search` is a read, so it sits behind `sso-viewer` exactly
  like `/read`. Add it to `authz_probe.py`'s table.
- a bounds test asserting `truncated` is set and the array respects the cap.

**Edge:** one more exact `Path()` rule in `edge/dynamic/portal-files.yml`
alongside `/read`, with the `sso-viewer` middleware chain. Never a `PathPrefix`.

### 1.2 The Search view in the UI

**Files:** `apps/portal-next/web/src/pages/files/` (new `Search.tsx`),
`ActivityBar.tsx`, `lib/files.ts`

`ActivityBar.tsx` currently says, in a comment, that there is **deliberately no
Search icon**, because "the explorer's filter is already above the tree, always
visible, and searches the same index a Search view would". That reasoning was
correct and stops being correct the moment content search exists — the two no
longer search the same thing. **Rewrite that comment rather than deleting it**:
record that the rail gained a third view when name-filtering and content-search
stopped being the same question.

The view: a query box, results grouped by file with the matching line and its
number, click to open the file at that line. The editor is CodeMirror and
already scrolls to a position for the git decorations.

### 1.3 Relative links in rendered markdown

**Files:** `apps/portal-next/web/src/pages/files/md.tsx`

Today a repo-relative link renders as `<span class="md-reflink">` with the
target beside it. Make it navigate **when, and only when, it resolves to a file
inside the same root**: join against the current file's directory, normalise,
and hand it to the same open-file action the explorer uses. It never becomes an
`<a href>` — it stays a button that calls the router — so the `javascript:`
argument in that file's comment is untouched and still true.

Unresolvable links keep today's rendering. That is the honest state and it is
also the one that tells you a link is broken.

### 1.4 Retire `apps/docs`

Only after 1.1–1.3 are live. One commit, and it touches more places than it
looks:

- `apps/docs/` — the whole directory (`compose.yml`, `mkdocs.yml`, `sync.sh`,
  `content/`, `.gitignore`)
- `justfile` — `up-apps`, `down`, `nuke`
- `scripts/doctor.sh` — the `expected` container list (`docs docs-sync`)
- `scripts/verify-access.sh` — `docs:8085:200` in the port baseline
- `apps/portal-next/web/src/pages/Overview.tsx` — the `docs` quick-link
- `apps/portal-next/web/src/lib/discover.ts` — the `docs.${BASE}` port entry
- `just urls`, `README.md`, `docs/kb/access.md`, `docs/kb/runbook-post-reboot.md`
- the root `.gitignore` line covering `apps/docs/content`

Follow the precedent already set for kafka and redis: say in `just urls` what
was removed, when, and that **it does not come back** — the mirror is
regenerable from the sources, so unlike those two nothing is lost, and the note
should say that plainly instead of implying a recovery path.

Port 8085 returns to the free pool; add it to `network/ports.md`.

**Done when:** `just verify` passes with the `docs` line gone from its baseline,
`just doctor` reports no missing container, and a search for a string that only
exists in `~/claude-notes` returns it from Bothy Files.

---

## Phase 2 — Bothy Control

### Why these two, and why now

`mgmt/compose.yml` makes the case against itself, in its own comments:

- **Portainer** holds a **read-write** docker socket. Its UI serves container
  `Env` — `POSTGRES_PASSWORD`, the Grafana admin password — and container exec,
  which is root on this box. Since the SSO chain was parked, its own login is
  "the ONLY thing between the tailnet and that", it is set interactively on
  first visit, and "an unclaimed instance is a total takeover for whoever claims
  it first".
- **Dozzle** mounts a second docker socket and carries a **third** credential
  store (`dozzle-users.yml`, its own `simple` auth). Its function — live
  container logs — is already served better by Bothy's log panel: Loki keeps
  logs *after a container stops*, and covers host processes through promtail's
  `host-processes` job.

So the log half of Dozzle is already done. What is missing is three verbs.

### The shape, and the trap to avoid

**Do not set `POST=1` on the existing socket proxy.** `apps/bothy/socket-proxy.yml`
says "POST=0 is load-bearing", and it is understating it: `POST=1` with
`CONTAINERS=1` grants the whole container POST family, which includes
`/containers/create`. The read-only surface must stay read-only.

Instead, the `portal-files` pattern, which exists and is proven:

```
browser
  → Traefik, exact Path(), forwardAuth requiring the `operator` role
    → bothy-control        (own network, NO published port, non-root,
                            read_only, no-new-privileges)
      → its own socket proxy on that network, POST=1, CONTAINERS=1, EXEC=0
```

`bothy-control` holds a **hard-coded allowlist of three verbs** — `restart`,
`stop`, `start` — and a container-id pattern. Nothing else is expressible. The
socket proxy's `POST=1` is then bounded by code that cannot be widened by an
environment variable, which is the property the current read-only proxy gets
from `POST=0` and would otherwise lose.

Explicitly out of scope, and say so in the compose comment so it stays out:
`exec`, `create`, `rm`, image pulls, volume operations. Those are `just`
recipes and an ssh session, and they should stay that way.

### 2.1–2.4

1. **`apps/bothy-control/`** — the service, its allowlist, an audit log with the
   same shape as the editor tier's (`who, action, container, outcome`), and a
   `checks/` directory. New network `controlnet`, holding exactly two
   containers, on the `filesnet`/`socketnet` precedent.
2. **`operator` role** in the Keycloak realm, a `sso-operator` forwardAuth
   middleware, and exact `Path()` routes in `edge/dynamic/bothy-control.yml`.
   Read stays on `viewer`; only the three verbs need `operator`.
3. **The UI** — actions on the service detail page and the system card. A
   confirm step for `stop` on anything the portal itself depends on (traefik,
   portal-next, portal-files, the socket proxies): stopping the edge from a page
   served through the edge is a foot-gun that deserves a sentence, not a toast.
4. **Retire `mgmt/`** — same checklist shape as 1.4. `portainer_data` is a real
   volume with real content (its own users and settings); back it up and then
   delete it, and record in `just urls` that it is **not** recoverable, the way
   the kafka/redis note does.

**Done when:** restarting a container from Bothy works, is refused without the
`operator` role, appears in the audit log, and `just verify` passes with ports
9000 and 8080 gone from its baseline.

### The one thing that is genuinely lost

Portainer can `exec` into a container from a browser. Bothy Control deliberately
cannot, and never will. That is a real regression for anyone who used it, and
the honest replacement is `docker exec` over Tailscale SSH. Write that down in
`just urls` rather than discovering it three months later.

---

## What must NOT be rewritten

Recorded here because the question will come round again:

- **Keycloak, Postgres, Traefik.** Identity, durable data and the front door.
  Nothing on this box is improved by a hand-rolled version of any of them.
- **node-exporter and cAdvisor.** They are the *source* Bothy's own Vitals
  panels already consume. Replacing them means reimplementing cgroup and
  `/proc` parsing to produce the same numbers.
- **Prometheus and Loki.** Time-series and log storage, retention, and query.
  The panels are ours; the databases should not be.
- **Grafana.** Bothy's panels are the *curated* view — the six things you look
  at every day. Grafana is the *ad-hoc* view — the question you have never asked
  before. Those are different jobs and one does not subsume the other.
