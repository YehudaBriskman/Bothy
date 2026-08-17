# The editing model: four ways in, one thing underneath

_Written 2026-08-17. Status: thinking, not yet a build plan._

The ask: users should be able to change things - a project's name, a route, a
container's config - through the UI, and there are four routes to an edit:

1. the **global files editor** (Bothy Files, shipped);
2. **per-thing UI** - forms on a project, a route, a container;
3. a **per-file editor** attached to whatever that thing is configured by;
4. a **terminal**, later.

The instinct is right. The design question is not "which of these do we build" -
it is **what stops them disagreeing with each other.**

---

## 1. The one thing underneath

Every configurable thing on this box is a file in git. Compose files, `.env`,
`project.dev.yml`, `edge/dynamic/*.yml`, `prometheus.yml`, `policy.toml`. There
is no configuration database and there never has been.

So the four routes are not four systems. **They are four ergonomics over one
substrate**, and that gives the governing rule:

> **A form is a typed lens over a file. It is never a second store.**

If a form writes to a database instead of the file, the repository stops
describing the box, `git log` stops being the history of it, and a `git pull`
silently reverts somebody's change. Everything below follows from refusing that.

The corollary is the good news: a form edit that goes through the *existing*
write path inherits, for free, every property that path already has - resolve and
deny rules, the conflict check, the undo snapshot, the audit line, and the role
gate at the edge. **Do not build a second write path.** Build a thing that
computes new file bytes and hands them to the one that exists.

---

## 2. The constraint that decides the implementation

**Half of these files are comments.**

| File | Lines | Comment lines |
|---|---|---|
| `edge/compose.yml` | 174 | 124 (**71%**) |
| `auth/compose.yml` | 459 | 299 (**65%**) |
| `apps/portal-files/compose.yml` | 112 | 70 (**62%**) |
| all `compose.yml` files | 1,485 | 754 (**50%**) |

Those comments are not decoration. The README's pitch is literally "every
non-obvious line carries a comment explaining **why** it is there, usually
because the alternative broke something". They are the most valuable content in
the repository, and several of them are the only record of a security decision.

The naive form implementation - `yaml.safe_load()` → mutate the dict →
`yaml.dump()` - **deletes all 754 of them** and reformats everything else. It
would look like it worked. The service would still start. The knowledge would be
gone, and it would be gone in a diff so large nobody reads it.

So, two hard requirements on any config writer:

- **Round-trip preserving**, e.g. `ruamel.yaml` in round-trip mode, or surgical
  text replacement that never re-serialises the document.
- **A no-op edit must produce a byte-identical file.** That is the test to write
  first, before any field is editable: load, change nothing, write, `diff`. If
  that is not empty, nothing else is safe to build.

There is a second-order consequence. `apps/portal-files` states, at the top of
`app.py`, that it has **no third-party dependencies** - "this container holds
read-write bind mounts on two git repositories, and every dependency is something
that can ship a vulnerability into that position". A YAML round-tripper is a
third-party dependency. **So the config tier is a separate service** from the
file tier, exactly as the action tier will be: `portal-files` keeps its property,
and the thing that needs a parser carries the parser and its own smaller mount.

---

## 3. Not everything is editable: three classes of field

An allowlist, declared in policy rather than coded, on the `policy.toml`
precedent - so widening it is a reviewable diff and not a code change.

**Class A - Bothy's own metadata.** `dev.portal.project`, `dev.portal.name`,
`icon`, `desc`, `order`. Changing these changes *what Bothy displays* and nothing
else. A wrong value is a cosmetic bug.

**Class B - declared configuration.** An image tag, a published host port, an
env var's value, a memory limit, a project's description in `project.dev.yml`.
A wrong value breaks one service and is visible immediately.

**Class C - the ones that are code.** `volumes`, `privileged`, `cap_add`,
`command`, `entrypoint`, `network_mode`, anything mounting a socket, and every
rule in `edge/dynamic/`. A wrong value here is arbitrary code on the box or a
credential leak. **These are not form fields.** They are edited in Files, by
someone who has read the comment above them, and reviewed as a diff.

**Start with class A, and specifically with the example that prompted this:
renaming a project.** It is the highest-value, lowest-blast-radius write
available - it proves the entire chain (form → patch → file → git → visible
change) while the worst possible failure is a card with the wrong title. Nothing
about the rest of the design has to be guessed at to build it.

---

## 4. Editing is not applying, and the UI must say so

A file edit does not change a running system. This is not a detail - it is the
single most confusing thing about the whole feature, and this box has already
been bitten by it: the `Role · Vendor` rename changed six compose labels and
**nothing on screen moved until every affected container was recreated**, because
a label is fixed at container-creation time.

So a rename through the UI is genuinely two acts:

```
edit    write the label into the compose file        `editor` role
apply   recreate the container so it takes effect    `operator` role
```

The interface has to carry that state, and the vocabulary already exists: the
collector's whole job is separating **declared** from **observed**. A service
whose file has changed but whose container has not is *config drift* - the same
shape as "declared but not running", and it should render in the same language,
not as a spinner that lies.

Tempting alternative, and worth stating so it is rejected on purpose: Bothy could
keep display metadata in its own file and render it instantly, no recreate. That
buys immediacy and costs the property this box is built on - the compose file
would say one thing and the screen another. **One place, with an honest pending
state, beats two places that agree most of the time.**

---

## 5. How the four routes relate

**Route 3 is not a feature. It is a link.** "Edit this service's config" should
open Bothy Files, scoped to that file, with the cursor near the field - not a
second editor component. Files already has the tree, search, git history, diff,
conflict handling and the undo net. A second editor would be a second set of
bugs and a second thing to secure. The work is a `configFile` pointer on a
service, which mostly exists already: the collector knows each project's root and
compose identity.

That collapses the four routes into three implementations:

| Route | What it is | Good for |
|---|---|---|
| Forms (2) | typed lens, allowlisted fields, validated | fields Bothy understands |
| Files (1 and 3) | the full text, one file or all of them | everything else |
| Terminal (4) | no model at all | what no UI models |

And the honest rule for which to reach for: **a form exists only where Bothy can
validate the value.** If it cannot say what is wrong before writing, it should
not be offering a text box - it should be offering the file.

**They will collide, and the answer already exists.** Two routes editing one file
is the ordinary case here (a form in one tab, Files in another, `vim` on the
box). The editor tier already solved it with a `baseMtime` conflict check, and
that comment says why it is load-bearing: writing straight to disk removed git as
the safety net. The form path must send the same `baseMtime` and get the same
409, not invent a second policy.

**The terminal is outside all of this**, and that has to be said out loud rather
than discovered: it bypasses the allowlist, the validation and the conflict
check. It is `shell`-role work - the role deliberately granted to nobody today -
and it should stay the most privileged thing on the box.

---

## 6. Routes are the special case

`edge/dynamic/*.yml` deserves its own paragraph because it is the one place where
a plausible edit takes the whole box down quietly. Traefik renders those files as
Go templates **before** parsing the YAML and does not skip comments, so a doubled
brace anywhere - including inside a comment - voids the entire file: no routers,
no middlewares, while the file on disk looks perfect.

Therefore, for routes: **generate, never free-edit.** The form asks which service
and which path, and Bothy writes the exact-`Path()` rule from the template that
already exists (`project.example.yml`). Write, then re-read Traefik's router
table and confirm the rule is present and enabled; if it is not, restore the
previous bytes from the snapshot that the write already took. `just verify` check
5b does the parse-failure detection today - the write path should run the same
assertion rather than hoping someone runs it later.

---

## 7. Who may do what

The roles exist and are already enforced on the file tier: `viewer`, `editor`,
`operator`, `shell`.

| Action | Role |
|---|---|
| see a settings page, see current values | `viewer` |
| change a class A or class B field | `editor` |
| apply - recreate, restart, run a declared start command | `operator` |
| terminal | `shell` (nobody) |

Attribution is already wired: `X-Auth-Request-Email` reaches the service and
lands in the audit log. Every form write should carry the same line, so "who
renamed this and when" is answerable without `git blame` - and `git blame`
answers it too, because the change is a commit.

The UI may hide what a role forbids. That is courtesy, not enforcement - the edge
decides, exactly as it does now.

---

## 8. What I would refuse

- **Parse-and-dump YAML.** It deletes 754 comment lines and looks like success.
- **A settings database.** Two sources of truth; the repo stops being the box.
- **A second write path.** Reuse resolve, conflict, snapshot, audit, role gate,
  or explain in writing why each is not needed.
- **Free-text editing of `edge/dynamic/` through a form.** Generate from a
  template, verify, roll back.
- **Rendering `.env` values.** Keys and set/not-set. The deny-list exists.
- **Class C fields as form fields.** `privileged`, `volumes`, `command`,
  socket mounts. Those are diffs, reviewed by a human who read the comment.
- **A form that silently drops what it did not understand.** If the writer meets
  a construct it cannot round-trip, it must refuse the write, not rewrite the
  file into something it can express.

---

## 9. The first thing to build

Rename a project from the UI, end to end:

1. `/-/api/me` so the page knows the user holds `editor`.
2. A config service (separate from `portal-files`, carrying the round-trip
   parser) with a byte-identity no-op test as its first check.
3. `policy` declaring exactly one patchable field: `dev.portal.project`.
4. A form on the system page. Writes through the existing write chain: resolve,
   `baseMtime` conflict check, snapshot, audit.
5. The **pending** state - "changed on disk, not yet applied" - and an Apply that
   recreates the container behind `operator`.

That is the whole architecture exercised on the safest possible field. Everything
after it is adding rows to an allowlist.
