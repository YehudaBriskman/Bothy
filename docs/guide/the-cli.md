# The `bothy` command

`bothy` is the half of Bothy you can have before you have a checkout. It
installs one, and after that it is a dispatcher: a small shell script that finds
your checkout and hands most of what you type to that checkout's `justfile`.

Knowing which half you are in matters, because it is the difference between a
command that works anywhere and one that needs to find a box first.

## Two kinds of subcommand

**Native.** Implemented in `scripts/bothy` itself, and the reason the script
exists at all.

| Command | What it does |
|---|---|
| `bothy init [dir]` | check prerequisites, clone, install `just`, record where the checkout is, and bring it up. Default directory is `~/bothy`. |
| `bothy download` | pre-fetch every image and dependency, so a later `up` needs no network |
| `bothy upgrade` | pull the checkout and apply it, preserving your data |
| `bothy self-update` | replace the `bothy` on your `PATH` with the checkout's copy |
| `bothy version` | what this checkout is - version, commit, whether it is modified, and where it lives |
| `bothy doctor --pre` | check prerequisites **before** a checkout exists |
| `bothy help` | the usage text |

**Dispatched.** Everything else is handed straight to `just` inside your
checkout. `bothy up` is `just up` run in the right directory:

```
up   down   doctor   verify   backup   logs <svc>   ps   urls   psql
files-check   portability   bootstrap   nuke
```

Three of these have friendlier names, and both spellings work:

| You type | It runs |
|---|---|
| `bothy status` | `just ps` |
| `bothy diagnostics` | `just doctor` |
| `bothy check` | `just verify` |

Anything not in either list is refused by name, with the usage text - a
dispatcher that passed unknown words through would be a way to run arbitrary
recipes by typo.

> [!warning] `bothy nuke` deletes every data volume
> It is in the dispatch table because it is in the justfile, not because it is
> safe. There is no confirmation flag here; the recipe is the thing that asks.

## How it finds your checkout

Every dispatched command has to `cd` somewhere first. Three sources, in order,
and the first one that names a real Bothy checkout wins:

1. **`$BOTHY_HOME`**, an explicit override. This is the one to set for a second
   checkout, or in CI. If it is set and is *not* a Bothy checkout, the command
   fails there rather than falling through - an override that is silently
   ignored is worse than one that stops.
2. **The path recorded by `init`**, in `~/.config/bothy/config` (or
   `$XDG_CONFIG_HOME/bothy/config`). One line: `BOTHY_HOME=/path/to/checkout`.
3. **Walking up from the current directory.** Standing anywhere inside a
   checkout, `bothy` finds it.

With none of the three, the command stops and says to run `bothy init` or set
`BOTHY_HOME`. It does not guess.

## What `init` actually does

In order, and it stops at the first thing it cannot do:

1. **Prerequisites.** `docker`, `git`, `curl`, `python3`, `openssl`, and
   `docker compose` as a working subcommand. Missing ones are listed by name.
2. **Clone**, unless the directory is already a Bothy checkout - in which case
   it is reused. A directory that exists, is not empty, and is not a checkout is
   refused rather than written into.
3. **`just`**, if it is not already there, into `~/.local/bin` via its official
   installer, pinned to that directory rather than run as root. If
   `~/.local/bin` is not on your `PATH`, `init` says so; nothing later will.
4. **Record** the path in the config file above.
5. **`.env` and secrets**, then bring the stack up.

`bothy doctor --pre` is step 1 on its own, and it is the only subcommand that
works with no checkout anywhere - which is the point of it. Run it before you
clone anything.

## `upgrade` and `self-update` are different things

This is the single most confusing thing about the CLI and it is worth being
blunt about:

- **`bothy upgrade` updates the box.** It pulls the checkout and re-applies it.
- **`bothy self-update` updates this script.** It copies `scripts/bothy` from
  the checkout over the `bothy` on your `PATH`.

They are separate because the `bothy` you run is a **copy**. The installer puts
`scripts/bothy` into `~/.local/bin/bothy`; `upgrade` pulls the repository. So
after an upgrade the checkout has a new CLI and the one you are running is
whatever was current the day you installed - which matters for a dispatcher,
because it resolves subcommands against a justfile it may no longer match.

`self-update` overwrites the file **this process was started from**, resolved
through symlinks, rather than an assumed `~/.local/bin/bothy`: overwriting a
path you did not choose is worse than refusing. If you are already running the
checkout's copy it says so and does nothing.

See [Upgrading](upgrading.md) for what `upgrade` does to your data.

## Reading `bothy version`

```
bothy version
```

prints the version, the short commit, whether the working tree is modified, and
the checkout path. The `(modified)` marker is the useful one: it is what
distinguishes two boxes claiming the same version, and the first thing to check
when a box behaves unlike its version number says it should.

## When to use `just` instead

Nothing about `bothy` is required. Inside a checkout, `just up` and `bothy up`
are the same command, and `just --list` shows every recipe including the ones
the dispatch table does not name. The CLI earns its place in exactly two
situations: before the checkout exists, and when you are not standing in it.

## Next

- [Upgrading](upgrading.md) - what `upgrade` touches, and what it deliberately does not
- [Installing Bothy](installing.md) - the longer version of `init`, and the manual path
