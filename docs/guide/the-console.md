# Operating it from the console

Bothy is the web application on `:80`. Open `http://<node-ip>/` and you land on
the Overview; everything else is one of three top-level destinations.

| Route | What it is |
|---|---|
| `/` | **Overview** - the box at a glance, and the front door |
| `/control` | **Control** - triage, then Services, Ports, Routes and Topology in a left sidebar |
| `/files` | **Bothy Files** - every document on the box, rendered. Its own page: [Bothy Files](files.md) |
| `/settings` | reachable from the person menu rather than the nav |

The nav carries three entries and not six on purpose. Services, Access and
Topology were three renderings of **one dataset** holding three of five nav
slots, which mis-states what the box contains; Files is a genuinely different
dataset. The argument is in
[`docs/plans/control-and-settings.md`](../plans/control-and-settings.md) § 2.
Every retired URL still redirects, query string included, because this is a
dashboard people deep-link to from notes and chat.

## The Overview

Ordered by the question it answers, largest type first:

1. **A status line** - up, unknown and stopped against the number expected, plus
   how many things want a look. This is the question the page exists for, so it
   is first and biggest.
2. **The attention strip** - what is actually wrong, and invisible when nothing
   is. A section that disappears on a healthy box and cannot be missed on a sick
   one; an empty triage panel is the report, not a design failure.
3. **The system matrix** - one card per system, discovered from Docker.
4. **Vitals** - CPU, memory and network, from Prometheus. Deliberately *below*
   the health answer: a row of charts above it would be three pretty things
   standing in front of the one sentence you came to read.
5. **Open a UI**, **Data and disk**, and the busiest containers.

**Everything on this page was discovered by asking Docker.** Bothy joins two
read-only APIs, both proxied under its own origin: Traefik's router table is the
skeleton, and the Docker socket proxy is enrichment. Either can die and the page
still renders. Start any container and it appears within ten seconds with no
edit to Bothy; stop it and its dot goes red just as fast.

One consequence worth knowing before you file a bug: a route with no container
is rendered loudly, as `unknown` with a "no container" badge, and it is not a
mistake. There is deliberately **no browser-side reachability probe** - a
cross-origin `fetch` returns an opaque response that resolves for *any* HTTP
status, so an earlier version reported 502 and 401 as "up" and dead services
rendered a green chip. Honest `unknown` beats a green lie.

## Control

`/control` opens on a triage page that says nothing at all when there is nothing
to say. When there is, it names three classes of problem that appear nowhere
else in one place:

- **systems with something wrong**, grouped by system rather than by service,
  because the answer to "what do I open" is a system page;
- **port collisions** - the Ports table is sorted by port so two rows on the
  same one are adjacent, but only if you went to look;
- **a disabled router** - one badge in one column of a table nobody opens until
  something is already broken.

The sidebar holds Services (every container, with its status, image and ports),
Ports, Routes (the live Traefik router table) and Topology, a lazily loaded 3D
rack view.

## The three verbs

Bothy Control does exactly three things to a container:

| Verb | What it means |
|---|---|
| `restart` | stop it and start it again. It keeps its configuration |
| `stop` | leave it stopped. It will not come back until something starts it |
| `start` | start a stopped container. It keeps the configuration it was created with |

The affordance is one small trigger per row, not three buttons. Which verbs it
offers depends on what the container is actually doing: a running container gets
Restart and Stop, an exited one gets only Start, and a container Docker is
flapping gets **Stop first**, because restarting something that is already
restarting is the least useful thing you can do. Offering all three always would
be simpler and worse - `Start` beside a running container is a button whose only
outcome is a 409, and the interface knew that before the click.

The result is reported as a **transition**: `from` state, `to` state, and how
long the daemon took. Both inspects happen server-side rather than being left to
the browser, because a UI that has to poll to find out what its own action did
will show a spinner during the gap and guess wrong about a container that was
already in the target state. `from == to` is a complete and honest answer.

Acting requires the **`operator`** role. What the interface hides is never what
the API enforces: the buttons are drawn inert without the role as a courtesy
that turns a bare 403 into a sentence arriving before the click, and a
hand-written `curl` is refused at the edge exactly the same way. See
[Roles](roles.md).

### Two refusals, and they are different in kind

**Foot-gun warnings.** Seven containers carry a sentence said *before* the act,
because stopping them takes away the page you are acting from - Traefik,
`portal-next`, the socket proxy, `portal-files`, `bothy-config`, Keycloak and
oauth2-proxy. Stopping Keycloak means nobody can sign in again, including you.
These are warnings. You may proceed, and the interface says the sentence rather
than overruling the decision.

**Hard refusals.** Four containers cannot be stopped or restarted at all, and
the rule that picks them is mechanical rather than a taste judgement:

> A container is refused if stopping it prevents **this request** from
> completing and reporting its own outcome.

That comes out at exactly four - Traefik (the request arrived through it),
`bothy-control` (the process holding the request), and its two socket proxies
(one is how every action begins with an inspect, the other is the only path to
the daemon at all). `apps/bothy-control/checks/grants.py` asserts the list is
still four, so it cannot quietly grow or shrink.

`start` is exempt from all of it. Starting something cannot remove a dependency
- it is the recovery verb, and refusing it would refuse the recovery.

The distinction is worth carrying: **the interface warns about what you might
regret, and the service refuses what it cannot describe.** Conflating them is
how a deny list turns into a list of things somebody once found scary.

Every action, refusal and failure is appended to an audit log at
`apps/bothy-control/audit/actions.log`, naming the actor from the session. It is
bind-mounted so that a rebuild does not erase it.

## What Bothy Control deliberately will not do

There is **no `exec`**, and no shell in the browser. `docker exec` is root on
this box, so the verb does not exist:

- `EXEC: 0` is written out explicitly on all three socket proxies rather than
  left to a default, each with the same comment - *container exec == root on
  this box* - and `checks/grants.py` asserts both that the variable is present
  and that its value is `0`;
- the verb list is a literal three-element tuple in
  [`apps/bothy-control/guard.py`](../../apps/bothy-control/guard.py), written
  out and never derived from the handlers, because a derived allowlist grows
  when the thing it is derived from grows;
- `kill` is absent from that tuple and a check asserts it stays absent. This is
  the interesting omission: the write proxy's `ALLOW_RESTARTS` flag grants
  `kill` alongside `stop` and `restart` in one rule that cannot be split, so the
  proxy would pass it and **that tuple is the only thing that refuses it**. The
  proxy is a coarse grant; the guard is the fine one;
- the `shell` role exists in the realm, is granted to nobody, and is referenced
  by no router.

Also out of scope, and staying there: `create`, `rm`, image pulls, volume and
network management, anything under `/build`. Those are `just` recipes and a
terminal.

This is a real regression for anyone who used Portainer, which was deleted on
2026-08-18, and it is stated rather than discovered later. The replacement is
`docker exec` over Tailscale SSH. `just urls` prints the same sentence to
whoever runs it, and
[`SECURITY.md`](../../SECURITY.md) spends a whole section on what a browser
shell would cost and the conditions under which it would be acceptable - written
first, on its own, so the boundary can be argued with before any capability
exists to point at as already done.

Two more things went at the same time and are worth naming: image, volume and
network management, which are the docker CLI; and a true streaming log tail -
Bothy polls Loki over a range instead, which also means logs survive the
container that produced them.

## Settings

Three groups, and only one of them changes anything:

- **You** - who the session says you are, which of the four roles you hold, and
  where the session came from. Read-only on purpose: all of it arrives with the
  token and is changed in the realm, not here.
- **Appearance** - the theme picker and the two ways to make one. This writes
  one key to this browser's local storage. See [Themes](themes.md).
- **Where these are kept** - which of the three stores holds what, and what is
  not stored at all.

The one rule to carry out of the roles panel: it is a description of a token,
not a permission check. A role missing from that list has never stopped a
request; it explains, in advance, the 403 that would have come back.

## Next

- [Bothy Files](files.md) - the reading and editing tier
- [Settings](settings.md) - and why most of it is read-only
- [Roles](roles.md) - who may do which of the above
- [Declaring a project](projects.md) - how a project of yours gets a card here
