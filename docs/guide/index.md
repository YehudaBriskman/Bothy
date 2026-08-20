# The Bothy guide

Bothy is a self-discovering console for one machine. This directory is the half
of the documentation written for somebody who has **not** read the source: how to
install it, which files you will actually end up editing, what the interface can
and cannot do, who is allowed to do it, and how to make it look like yours.

The reference documents stay where they are and are linked from here rather than
restated. That is a rule and not a preference: this repository has twice shipped
documentation describing services that had already been deleted, and a duplicated
paragraph is a paragraph that goes stale in the copy nobody is looking at. Where
a fact lives in a file, these pages name the file.

## Where to start

The pages are in reading order. Nobody needs all of them; the four groups are
the four reasons somebody opens this directory.

### Getting it running

| If you want to | Read |
|---|---|
| get it running on a machine that has never had it | [Installing Bothy](installing.md) |
| know what `bothy up` actually does, and where it looks for your checkout | [The `bothy` command](the-cli.md) |
| know which YAML is load-bearing, and what happens when you save it | [The files you will actually edit](configuring.md) |

### Using it

| If you want to | Read |
|---|---|
| use the thing - Overview, Control, the three verbs | [Operating it from the console](the-console.md) |
| read, search and edit the box's own files from a browser | [Bothy Files](files.md) |
| know why Settings mostly does not change anything | [Settings](settings.md) |
| understand `viewer`, `editor`, `operator` and the role nobody holds | [Roles](roles.md) |
| pick a theme, or write one | [Themes](themes.md) |

### Putting your own things on it

| If you want to | Read |
|---|---|
| add a container this repository runs | [Adding a service to the stack](services.md) |
| make a project of your own visible, including while it is off | [Declaring a project](projects.md) |

### Keeping it running

| If you want to | Read |
|---|---|
| know what is scraped, what is kept, and for how long | [Monitoring](monitoring.md) |
| know what is backed up, what is not, and how to restore it | [Backups](backups.md) |
| move to a newer version without losing data | [Upgrading](upgrading.md) |
| work out why something is broken | [When something is wrong](troubleshooting.md) |

## What is documented elsewhere, and why it stays there

- The repository map, the three ideas the design rests on, and the traps that
  cost real debugging time: [`README.md`](../../README.md).
- The threat model - what "safe on a tailnet" does and does not mean, why the
  socket proxy is protected by a network rather than a password, and what a
  browser shell would cost before one exists:
  [`SECURITY.md`](../../SECURITY.md).
- The request path, the networks, the discovery join and the checklist for
  adding a service: [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).
- Working on the code, the branch and commit rules, the portal's own test
  suites: [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
- [`docs/kb/`](../kb/README.md) is deliberately **not** part of this guide. It is
  one machine's operational history - real addresses, real incidents, runbooks
  for that box. It is correct, and it is not user documentation.
- [`docs/plans/`](../plans/reading-first.md) holds design arguments written
  before the code. They are the best explanation of *why* several of the choices
  below are what they are, and they are not kept in step with what shipped.

## What this guide does not pretend

- **Bothy is not a production platform.** Plain HTTP everywhere, one node, one
  user, backups on the disk they protect. It is safe on a WireGuard tailnet and
  it is not safe on a LAN or the internet. `SECURITY.md` argues this properly.
- **There is no shell in the browser, and that is a decision.** `docker exec` is
  root on the machine, so the Control tier has no `exec` verb and the `shell`
  role is granted to nobody. See [Operating it from the console](the-console.md)
  and [Roles](roles.md).
- **Only three tiers are behind single sign-on.** Everything else - Grafana,
  Prometheus, Keycloak's own console - carries its own login on one shared dev
  credential, and the tailnet is the rest of the control. "SSO is running" does
  not mean "this is behind SSO".

## A note on addresses

Every page here writes the machine's address as `<node-ip>`. Bothy publishes a
host port per browser-facing service and is reached at
`http://<node-ip>:<port>`; there is no name layer, and a `Host()` rule in
Traefik would register happily and then match nothing, forever. `just urls`
prints the real table on the box you are standing at.
