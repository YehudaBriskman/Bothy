# Plan: a shell in the browser, and the second factor in front of it

_Written 2026-08-19. Status: proposed. Nothing built._

Issue #90. This document exists **before** any code because the capability is
root-equivalent, and a root-equivalent capability whose reasoning is visible only
in a diff is not reviewable.

---

## 1. What was asked, and the correction

Earlier analysis in this repository — including the section currently in
`SECURITY.md` — read "shell" as `docker exec`. **That is half of it.** The ask is
one terminal feature with **two target kinds**:

1. **a container** — attach a shell to something running;
2. **a filesystem area the user can already reach** — remote development in the
   work area, in the sense that VS Code Web is remote development.

Anything below that reasons about only one of those is answering a question
nobody asked. The `EXEC=0` analysis in `SECURITY.md` is that mistake and is
corrected as part of this work; its blast-radius reasoning survives untouched.

**Surface: a terminal inside Bothy**, a fourth top-level entry beside Overview,
Control and Files. `code-server` and the other browser IDEs were considered and
deferred to their own issue — they duplicate Bothy Files, bring their own auth
and update cadence, and answer a larger question than the one asked.

---

## 2. The fact that shapes every other decision

Measured on this box, 2026-08-19:

```
exec is root immediately in:   cadvisor                    privileged: true
                               traefik, promtail,
                               bothy-socket-proxy,
                               bothy-control-socket-read,
                               bothy-control-socket-write  each mounts docker.sock

a host shell as devssh:        uid 1000 is in 989(docker) and 27(sudo)
                               docker run -v /:/host  ->  root
```

**Every path to a shell on this box is root-equivalent.** Six of roughly twenty
containers hand out root on exec, and the host shell does so through group
membership without touching Docker's API at all.

The consequence is worth stating plainly because it removes a design that looks
attractive: **there is no useful "safe subset" of targets.** Allowing exec into
only the unprivileged containers buys nothing while a host shell is one entry in
the same menu, and shipping that subset would suggest a boundary that does not
exist. A control that misrepresents what it controls is worse than no control,
because it is trusted.

So the control is not *which targets*. It is **who holds `shell`, and what they
prove to use it.**

---

## 3. Why step-up ships with it, not after it

The honest argument for this feature is that the operator already has SSH, so a
browser terminal grants no new capability to the person it is for. That argument
is sound and it has one hole:

> **SSH is a tailnet key. This is a cookie**, on an origin whose pages need no
> login to browse.

Those are not the same credential. The key is a device secret; the cookie is
whatever the browser is holding, obtainable by anything that can run script on
that origin or reach an unlocked machine. Until now the worst that bought was a
container restart. It would now buy root.

Step-up closes exactly that gap and nothing else, which is why it belongs in the
same change rather than behind it. Half of it is already in the repository and
inert: `acr.loa.map = {"standard":1,"stepup":2}` in `auth/realm-devbox.json`.
The remaining five steps are written out at `auth/compose.yml` ~257-274. Step 5
is the expensive one and the reason this is not a small change:

> a **second oauth2-proxy instance**, because `--acr-values` is per instance and
> the existing one is shared by everything.

**The realm import is first-boot-only** (`auth/compose.yml` ~213-215), so the
`browser-stepup` flow has to be created by `keycloak-init`, which re-runs on
every `just up-auth`. A flow that only exists on a box installed after this
lands is a flow that does not exist.

---

## 4. The pieces

| | |
|---|---|
| a PTY service | a terminal over a websocket, target-aware |
| `browser-stepup` | a Keycloak flow, created by `keycloak-init` so it reaches boxes past first boot |
| a second oauth2-proxy | dedicated to the shell route, carrying `--acr-values=stepup` |
| `policy.toml` | `~/projects` becomes writable — see §6 |
| audit | every session recorded, on `apps/portal-files/app.py`'s append-only model |
| the panel | a fourth top-level entry, target picker, themed with the rest |

---

## 5. THE UNKNOWN THAT COULD CHANGE THE SHAPE

**Nothing in this repository carries a websocket through Traefik today.** Grepped
`edge/dynamic/*.yml` and `edge/compose.yml`: no `Upgrade` handling, no websocket
middleware, no existing route to copy. Every route here is request/response.

So the path — browser → Traefik → **oauth2-proxy forwardAuth** → a long-lived
upgraded connection — is untested. forwardAuth authorises a *request*; a
websocket is one request followed by a connection that outlives it, and what
happens when the session expires mid-connection is a question this repo has never
had to answer.

**This is the first thing to prove, before any terminal work.** If the answer is
that the upgrade cannot carry the auth cleanly, the shape changes — a published
port with its own boundary rather than a route behind the shared edge — and that
is a different design, not a detail.

---

## 6. Consequences worth deciding deliberately

**`~/projects` becomes writable.** It is `ro` today
(`apps/portal-files/compose.yml`, `policy.toml`). Development in the work area
needs it `rw`. Note `policy.toml`'s existing reasoning: `home` is read-only
because it **overlaps every other root**, and a shell whose target list includes
both `home` and `projects` reintroduces exactly that overlap through a door the
file service closed.

**`grants.py` asserts `EXEC=0` on every socket proxy it sweeps.** If container
targets need exec, that assertion has to change. It must be **replaced by a
narrower one that still refuses everything it currently refuses** — never
deleted. The sweep exists because a third proxy once walked past a by-name check;
weakening it to admit a fourth would undo that.

**A terminal emulator is a new front-end dependency.** `CodeSurface.tsx`'s header
lists what this repo declined and why; whatever is chosen belongs in that
register, with its gzip cost stated.

**`guard.SEVERING` cannot survive a real PTY.** #90 asks that you not be able to
stop the container serving the page you are typing into. A shell can `docker
stop` itself or `kill -9` its parent, and a name-keyed refusal list cannot see
either. That requirement is satisfiable by the design, not by the guard, and the
issue should be amended rather than have this surface in review.

---

## 7. What this plan refuses

- **A "safe subset" of exec targets.** §2 — it would imply a boundary that is not
  there.
- **Shipping the terminal before step-up.** The maintainer chose one PR for both;
  §3 is why that is the right call rather than caution.
- **`code-server`.** Deferred to its own issue, judged with real usage behind it.
- **Granting `POST=1` with `CONTAINERS=1` to any proxy.** That pair is
  `/containers/create`, and create with a bind mount of `/` is root. `grants.py`
  refuses it across every compose file in the repo and must keep doing so.
