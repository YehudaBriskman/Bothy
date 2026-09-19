# Upgrading

An upgrade is two commands, and they update two different things. Running only
one of them is the most common way to end up confused about what version you are
on.

```
bothy upgrade        the BOX - moves the checkout to a newer release and applies it
bothy self-update    the SCRIPT - replaces the bothy on your PATH
```

## Two paths: with the host updater, and without

`bothy upgrade` does one of two things, depending on whether the host updater is
installed (`just install-updater`, which puts it in
`~/.local/lib/bothy-updater/current`):

- **Installed** - the normal case on a box that runs Settings > Updates. It is
  the **same** plan and executor the Update button drives
  ([docs/plans/updates.md](../plans/updates.md) step 6), from a shell:
  1. `git fetch`, then pick the newest **release tag** on `origin/main` that is
     ahead of the checkout and whose commit's CI check runs all passed (asked
     through `gh` when it is logged in, else GitHub's API unauthenticated). Not
     `main`'s tip: a tag is what `release.yml` cuts only on a green commit.
  2. Show the plan - release notes, commits, what is rebuilt, which other
     stacks' files come along unapplied, whether the updater itself changes -
     and ask (`--yes` skips the question; a plan touching compose, edge or other
     stacks asks you to type `bothy`).
  3. Build `bothy-web:<sha>`, `bothy-files:<sha>` and `bothy-ops:<sha>` from a
     temporary worktree of the tag, **before** anything running changes.
  4. Arm a rollback timer (`systemd-run --user`), fast-forward the checkout,
     bring up bothy-files, bothy-ops and bothy-web - web last - on those
     images, and verify: the images and their labels, `/version.json`, the
     `/healthz` bodies, the catch-all's `index.html`.
  5. Verify passing disarms the timer. Verify failing - or the updater dying, or
     WSL restarting - lets it fire: `git reset --hard` back to the previous
     commit (safe because step 1 refused a dirty tree) and the previous images,
     **without a build**. That release is then not offered again.

  It refuses, and says why, on a dirty or untracked tree, a branch other than
  `main`, a checkout that has diverged from `origin/main`, a tag that is not on
  `main` or not green, and a release that touches the socket-proxy boundary. It
  updates **Bothy's own three services only**: other stacks' pins that arrive
  with the checkout are then offered on their own rows in Settings > Updates.
- **Not installed** - a fresh install, CI, a box that never ran
  `just install-updater`. The original path below: `main`'s tip, pulled and
  applied, with no rollback. It says so when it runs.

If a release changes the updater itself, the new copy is **staged** and not
switched: the program doing an update never replaces itself mid-run. Settings >
Updates and `just update-status` say a switch is pending; `just install-updater`
makes it.

## What `bothy upgrade` does without the updater

Four steps, and it stops at the first that fails:

1. Find the checkout ([The `bothy` command](the-cli.md) explains how) and enter
   it.
2. `git pull --ff-only`. Fast-forward only, so a checkout with local commits or
   local edits **refuses to upgrade** rather than merging. That is deliberate:
   the alternative is a merge conflict inside a directory that is also a running
   system.
3. If the commit did not move, it says so and stops. There is nothing to apply.
4. `just up`.

That last step is the whole of "apply". There is **no `down`**, and no `-v`.

## Bothy's own code is rebuilt, not just restarted

Most of the stack is third-party images named by a pinned tag, and a new pin is
applied by `up` pulling it. Bothy's own three services - bothy-web, bothy-files
and bothy-ops - are different: they are **built from this checkout**, and
`up` on its own never rebuilds an image that already exists. So `just up-apps`
(which `just up` runs) builds them first, then brings them up:

```
docker compose -f apps/bothy/compose.yml build     # a no-op when nothing changed
docker compose -f apps/bothy/compose.yml up -d --wait ...
```

The build is cached layer by layer, so an upgrade that did not touch the apps
costs seconds. It **does** need the network when their sources or base images
changed (`npm ci`, and the pinned `node`, `nginx` and `python` bases), which is
why `bothy download` builds them too.

Before 2026-09-18 this step was missing, and an upgrade applied every new
compose file and **none of the new app code** - the old images kept running,
healthy, with nothing to say so.

Each image is labelled with the commit it was built from, so you can check:

```
docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' bothy-web
git -C ~/stacks rev-parse HEAD                      # should match
curl -s http://<box>/version.json                   # the same, as a browser sees it
```

The label is `HEAD` at build time, so every new commit relabels the three
images and `just up` recreates those three containers - a few seconds of
downtime for Bothy's own pages, and nothing else restarts.

The image **tag** is the commit too: `bothy-web:<sha>` (compose reads
`BOTHY_IMAGE_TAG`, which `just up-apps` sets to `HEAD`'s sha). The previous
commit's images therefore survive a build under their own name, which is what
lets the updater's rollback run them again without building anything. `up-apps`
keeps each image's three newest commits and never removes one a container runs.

An open tab notices an update by itself: it polls `/version.json` and shows
**"Bothy updated - reload"** when the served revision is no longer the one it
loaded. A lazy-loaded page part that no longer exists reloads the tab once.

## Your data survives and the new code runs, and both are tested

`just up` recreates containers whose definitions or images changed and leaves
volumes alone. That this preserves data and applies the new code is asserted in
CI by the Upgrade
workflow (`.github/workflows/upgrade.yml`), which installs the previous commit,
writes a row to the database, upgrades to `HEAD`, and then checks three things:

- the row is still readable;
- **no volume was recreated** - compared by volume **ID**, not by name, because
  a recreated volume keeps its name and comparing names would pass exactly when
  the data was lost;
- **the running code is `HEAD`'s** - bothy-web, bothy-files and bothy-ops run
  images labelled with the new commit, `/version.json` names it, and the
  `index.html` bothy-web serves is byte-identical to a fresh build of `HEAD`'s
  sources. The data checks alone passed for months while no upgrade applied app
  code at all.

So the thing that would break this is not an ordinary upgrade. It is somebody
adding a `down -v` to the apply step, renaming a volume in a compose file, or
dropping the build from `up-apps` - which that workflow exists to catch.

Take a backup anyway before an upgrade you are unsure about. See
[Backups](backups.md); it is one command and the restore path is documented.

## Upgrading with no network

`bothy download` pre-fetches every image named by **every** compose file in the
checkout - not only the ones `up` starts, because the point of the command is
that a later `up` needs no network at all, and that includes the tiers you may
start by hand. `pull` skips Bothy's own three images, which are built rather
than pulled, so it also **builds** them - which fetches their base images and
the portal's npm packages - leaving the build inside `up` all cache hits. It
also runs `npm ci` for the portal's web sources if `npm` is present, for local
development; the image build does its own.

The order for an offline or slow-link upgrade is:

```
bothy upgrade      # pulls the checkout and builds the apps (needs the network)
bothy download     # pulls the images
bothy up
```

`upgrade` already runs `up` at the end, so on a good link the middle step is
just insurance. If the link drops partway, run `bothy download` and then
`bothy up`: every build step that already finished is cached.

## After upgrading, update the CLI too

The `bothy` on your `PATH` is a **copy** of `scripts/bothy`, made when you
installed. `upgrade` pulls the repository and does not touch it. That drift is
harmless right up until the day a subcommand is added, removed or renamed - and
then a dispatcher is resolving what you typed against a justfile it no longer
matches.

```
bothy self-update
```

`scripts/checks/cli-commands.sh` asserts that every subcommand the CLI names
still resolves - but it asserts it **inside a checkout**. Nothing checks the
copy on your `PATH`, which is exactly why the command exists.

## Checking what you are on

```
bothy version
```

Version, short commit, `(modified)` if the working tree is dirty, and the
checkout path. The `(modified)` marker is the one that matters when a box
behaves unlike its version number says it should: it is the only thing that
distinguishes two machines claiming the same release.

## When an upgrade goes wrong

- **`pull failed - the checkout has local changes or has diverged`.** Expected,
  and the right answer is not `--force`. Look at `git status` in the checkout.
  If the change is yours and wanted, commit it on a branch; if it is not, it is
  usually an edit made through [Bothy Files](files.md), and the file's history
  is in the reader.
- **The pages look unchanged after an upgrade.** Compare the revision label
  (above) with `git rev-parse HEAD`. If they differ, the build did not run or
  failed - `just up-apps` again shows why. A browser tab that was already open
  keeps the old page until it reloads.
- **A container will not start after an upgrade.** `bothy doctor` first - it
  covers containers, ports, routes, targets, DNS and disk, and the failing line
  is often not the one you expect. See [Troubleshooting](troubleshooting.md).
- **A setting you changed has stopped taking effect.** Editing is not applying.
  A changed label or port does nothing until the container is recreated; see
  [The files you will actually edit](configuring.md).

## Next

- [Backups](backups.md) - what to take before an upgrade you are unsure about
- [Troubleshooting](troubleshooting.md) - when the box comes back up wrong
