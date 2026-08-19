# Plan: Control, Settings, and turning declarations into a UI

_Written 2026-08-17. Status: proposed, nothing started._

Four asks, in the order they were made:

1. **Shrink the top nav.** Services, Access and Topology come out of it and go
   behind one entry, which opens a section overview with its own left sidebar.
2. **Make that the pattern**, not a one-off: the top nav carries the highest
   level only, everything below it navigates from an inner sidebar - "an inner
   ecosystem".
3. **Call it Control**, and let it own services and access.
4. **Settings**: per user, and per system - including "a compiler from compose &
   env into an interactive UI for users to run stuff".

---

## 1. What is already right, and must not be rebuilt

**The inner-sidebar pattern is already in the product and already works.** Bothy
Files has an activity strip, a rail that changes what it shows, resizable panes
that persist, and a keyboard route to all of it (`panes.ts`, `ActivityBar.tsx`).
This proposal is not a new invention - it is propagating a pattern that shipped
and stuck. That is the strongest argument for doing it, and it also means the
hard parts (resize, collapse, persistence, focus order) have a reference
implementation rather than a blank page.

**Intent is already modelled.** `apps/portal-collector` exists precisely because
"the portal only ever recorded observed facts, never intent". It reads each
project's `project.dev.yml`, reconciles the declaration against host truth, and
already carries a `start` command, a `ui` flag per service, and states that
distinguish `stopped` from `stuck` from `collision` from `unverified`.

That last point reframes ask 4 completely, and it is the most important
conclusion in this document: **do not build a compose parser.** The declaration
layer exists. See §6.

**Deep links already have a migration precedent.** `/ports` and `/routes` are
already `<Navigate>` redirects into `/access?tab=…`. Moving routes is a thing
this app has done before and done correctly, which sets the standard: every
existing URL keeps working.

---

## 2. What is actually wrong with the nav

Not "it has too many things" - that is taste. Three specific defects:

**Nav slots track VIEWS, not datasets.** Services, Access and Topology are three
renderings of one dataset: the merged node list from `merge()`. Files is a
genuinely different dataset with a different mental model. Giving one dataset
three top-level slots and another one slot mis-states what the box contains. It
is the footprint rule (`principles.md`: an element's footprint is proportional to
the information dimensions it carries) applied to navigation.

**Access already nests navigation inside navigation.** Today: top nav → Access →
tabs (Routes / Ports). Three levels, and the third one *hides* - you cannot see
Ports exists until you land on Access. A sidebar entry is visible from the
section landing; a tab is not.

**Topology is beautiful and thin.** A 3D rack view is the most expensive thing on
the box to render and answers roughly one question ("what talks to what"). It has
earned a place in the section; it has not earned a peer slot beside the Overview.

---

## 3. The target shape

```
TOP NAV        Overview          the box at a glance - unchanged, stays the front door
               Control           everything that is running and how you reach it
               Files             the box's contents
               ·
               (right cluster)   Live · Search · Refresh · Theme · You
```

Three entries, plus a person menu where the theme toggle already lives.

```
/control                    the section overview
  ├── Services              the table, filters, search
  ├── Ports                 (was /access?tab=ports)
  ├── Routes                (was /access?tab=routes)
  ├── Topology              the 3D view
  └── Actions               start · stop · restart          [when §5 lands]
```

**Routes and redirects.** New paths under `/control/*`; every old path becomes a
`<Navigate replace>`, exactly as `/ports` and `/routes` already are:

| Old | New |
|---|---|
| `/services` | `/control/services` |
| `/services/:id` | `/control/services/:id` |
| `/access` | `/control/ports` (its default tab today) |
| `/access?tab=routes` | `/control/routes` |
| `/topology` | `/control/topology` |
| `/systems/:name` | `/control/systems/:name` |
| `/ports`, `/routes` | already redirect; re-point them |

A redirect that drops a query parameter is a broken link with a 200, so
`/access?tab=ports` must land on Ports, not on the section overview.

**What the section overview is for.** Not a fourth copy of the Overview's
counts. It answers "what would I click next": the systems with something wrong,
the ports that collide, the routes in an error state - each a link into the
sidebar entry that owns it. If it cannot say something the Overview does not, it
should be a redirect to Services instead. Decide that with the page in front of
you, not now.

---

## 4. The naming ruling

**Use `Control`, and be aware it is a promise.**

Two problems, both solvable.

**It collides with "Source Control", already in Bothy Files' rail.** The brand
review flagged this and it is real. The fix is one word: rename that rail entry
**Changes**. VS Code calls it Source Control; Bothy does not have to, and
"Changes" is what the badge actually counts.

**"Control" is a verb, and today the section cannot do anything.** Services,
Access and Topology are all read-only. Shipping a section called Control that
controls nothing is the *parked configuration* mistake in naming form - the exact
error this repo already paid for once with dead Traefik routers, and wrote down
as "either keep a layer working or delete it".

So, one of two - and this is a decision to make now, not later:

- **Ship at least one action with the rename** (restart is the obvious first: it
  is idempotent, it is what you actually reach for, and it is the least
  destructive of the three). Then the name is true on arrival.
- **Or call the section `Systems` until actions land**, and rename it to Control
  in the release that makes it able to control.

Recommendation: the first. The action tier is designed already (§5) and the
rename is a bad thing to do twice.

**In the UI it is "Control", not "Bothy Control".** The two-register rule from
the brand work: bare nouns in the interface, "Bothy X" in prose and marketing.
The nav says `Files`, not `Bothy Files`, today - this follows that.

---

## 5. Actions: what Control actually controls

This is the plan already written in
[`first-party-stack.md`](first-party-stack.md) §2, unchanged, and it slots
directly into the new section as its `Actions` entry (and as row-level buttons on
Services).

Three verbs - **restart, stop, start** - behind the `operator` role, in a service
that holds a hard-coded allowlist, on its own network with its own socket proxy.
The critical constraint, restated because it will be tempting to skip: **do not
set `POST=1` on the existing read-only socket proxy.** `POST=1` with
`CONTAINERS=1` grants `/containers/create`. The mutation surface must be code you
wrote, not an environment variable away from being everything.

Explicitly out of scope, and it should be written into the compose file so it
stays out: `exec`, `create`, `rm`, image pulls, volume operations.

**A confirm step for anything Bothy depends on** - traefik, portal-next,
portal-files, the socket proxies. Stopping the edge from a page served through
the edge deserves a sentence, not a toast.

---

## 6. Settings, and the "compiler"

### 6a. The blocker nobody has hit yet: Bothy does not know who you are

There is no `/-/api/me`. oauth2-proxy sets `X-Auth-Request-Email`,
`X-Auth-Request-User` and `X-Auth-Request-Groups` on requests it forwards, and
`portal-files` uses the email to attribute a write - but the SPA never sees any
of it. Consequences today:

- the page cannot say who is signed in;
- it cannot hide an action the user's role forbids, so the only feedback is a 403
  after the click;
- "per-user settings" has nothing to key on.

**So step one of all settings work is a `/-/api/me` endpoint** returning
`{ user, email, roles }` read from those headers, behind `sso-viewer`, as an
exact `Path()` route. It is small and it unlocks everything below.

One rule, and it is the same one the editor tier already follows: **what the UI
hides is not what the API enforces.** Client-side role checks are courtesy.
Every action stays gated at the edge regardless of what the page renders.

### 6b. Per-user settings

Worth separating two things that "settings" collapses:

| Thing | Belongs to | Store |
|---|---|---|
| theme, pane widths, collapsed groups | the **browser** | `localStorage` - already correct, leave it |
| identity, roles, what you may do | the **user** | `/-/api/me`, read-only |
| default root, default landing page, favourites | the **user** | needs a real store |

Only the third row needs new storage, and it is the least valuable of the three.
**Recommendation: do not build a per-user preference store yet.** Ship `/-/api/me`
and a Settings page that shows who you are, which roles you hold, what each role
permits, and where the session comes from. That is genuinely useful, honest, and
carries no write path. Revisit persistence when there is a preference somebody
actually asks to keep.

If it is built later, the store is Postgres (Keycloak already lives there), a
`bothy` schema, one small table, and a write path that needs the same treatment
as every other write path on this box.

### 6c. System settings, and the compose/env compiler

**The idea is good and it is the same idea the Overview is built on** - a UI
generated from declarations rather than hand-maintained. That thesis has already
paid off twice here, so extending it to configuration is principled rather than
speculative.

**But do not parse compose to do it.** Two reasons:

- The declaration layer already exists (`project.dev.yml` + the collector), it is
  already reconciled against host truth, and it already carries `start`, `ui` and
  per-service state. Building a second, parallel understanding of what a project
  is guarantees they will disagree - and the portal has already been burned by
  two implementations of one rule (three copies of the display-name lookup, which
  is what made a system read two different ways on two pages).
- A compose file is not a form. It is a program: `privileged`, arbitrary bind
  mounts, arbitrary commands. A UI that round-trips compose is a UI that can
  write arbitrary code onto the box.

**Never render env VALUES.** `~/stacks/.env` holds 19 real secrets, which is why
`safepath` refuses `.env` by name today. The compiler shows **keys and whether
they are set** - `POSTGRES_PASSWORD  set`, `ALERT_EMAIL_TO  not set` - and never
the value. This is not a nice-to-have; a settings page that prints the contents
of `.env` to any tailnet viewer undoes a control that already exists.

Three layers, in increasing risk. Ship them in order, and treat each boundary as
a separate decision:

**Layer 1 - Introspect (safe, do this first).** Render what the declaration
already says: services, their declared ports, whether they are up, which env keys
they expect and whether each is set, what `start` command exists. All derived,
all read-only, no new privilege. This alone answers "what is this project and is
it healthy", which is most of the value.

**Layer 2 - Run (medium).** A button that executes the declared `start` - not an
arbitrary command, *the one the declaration names*. Same shape as §5: `operator`
role, audit log, bounded verbs. The declaration is the allowlist, which is the
elegant part: a project opts in by declaring, and nothing else is runnable.

> **2026-08-19, from #91: this is not the same shape as §5, and the difference
> is the whole cost.** §5 acts on a container through a socket proxy. A declared
> `start` is a HOST SHELL COMMAND - `just up`, `tilt up` - so running it needs a
> process on the host that executes strings, which is
> [`SECURITY.md`](../../SECURITY.md)'s shape 3: no socket grant moves, and the
> boundary that does move is "the portal cannot run code". Routing it through
> Docker instead is worse, not better: creating a container is
> `/containers/create`, and `POST=1` with `CONTAINERS=1` is the pair
> `apps/bothy-control` was split into two proxies to avoid.
>
> What shipped from #91 is the part that needs neither: a declared service whose
> container EXISTS gets the three verbs it was already entitled to (that is
> `/containers/<name>/start`, already in `guard.VERBS`), and a declared service
> with no container says so and prints the command instead of running it. Layer
> 2 as written above remains undone, and it is a host-executor decision rather
> than a UI one.

**Layer 3 - Change (dangerous, decide separately).** Editing values. If it
happens: field-level allowlist declared in the project file (not "any key"), a
diff-and-confirm before writing, an audit entry, and a written threat model
first. Free-text editing of compose or `.env` through a browser is the editor
tier with more privilege and fewer guards - if that is what is wanted, say so
plainly and design it as such rather than arriving there by increment.

---

## 7. Sequence

Each step is independently shippable and leaves the product coherent.

1. **`/-/api/me`** - identity and roles reach the browser. Unblocks everything,
   no UI change required.
2. **The section shell** - `/control` with its sidebar, all existing pages moved
   under it, every old URL redirecting. Pure IA; no new capability. Rename the
   Files rail entry to **Changes** in the same change.
3. **Actions** - restart/stop/start behind `operator`, in Control. This is what
   makes the name honest, and it retires Portainer and Dozzle
   ([`first-party-stack.md`](first-party-stack.md) §2).
4. **Settings page** - who you are, what you may do, where the session came from.
   Read-only.
5. **Project introspection (layer 1)** - the declaration rendered.
6. **Run (layer 2)** - the declared start command, behind `operator`.

Layer 3 is deliberately not on this list.

---

## 8. What I would push back on

- **A section called Control that cannot control.** Either an action ships with
  it or it is called Systems. §4.
- **A settings page that writes before it can read.** `/-/api/me` first; the
  page has nothing to key on without it.
- **Rendering `.env` values anywhere, ever.** Keys and set/not-set only.
- **A generic compose editor with a nice skin.** That is not a compiler, it is
  remote code execution with a form.
- **Sidebars on pages that do not need one.** The ask is "this design for almost
  all of the pages" - Overview and Files should not get one. Overview is a
  single view; Files already has a better version of the same idea. A sidebar
  holding one link is furniture.
