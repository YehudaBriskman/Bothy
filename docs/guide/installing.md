# Installing Bothy

Two supported paths. Both end at the same place: a checkout you can read, a
`.env` full of secrets that were generated rather than typed, and about
twenty-six containers running.

The install is exercised on every pull request by
[`.github/workflows/install.yml`](../../.github/workflows/install.yml) - clone
into an empty directory, `cp .env.example .env`, `just up`, then every test
suite in the repository run against the stack that came up. Nightly,
[`.github/workflows/elsewhere.yml`](../../.github/workflows/elsewhere.yml) runs
the same job at a path with a space in it and at a deeply nested path, because
every portability bug this repository has had looked fine at exactly one path.

## Before anything

Bothy needs **docker with the compose v2 plugin, git, curl, python3 and
openssl**. That list has one definition, in `check_prereqs()` in
[`scripts/bothy`](../../scripts/bothy), and everything else asks that function
rather than repeating it.

- `just` is deliberately not in the list. `bothy init` installs it into
  `~/.local/bin` for you; being the thing that removes that requirement is a
  large part of why the CLI exists.
- `jq` is optional and worth having. Without it `just doctor` reports less than
  it should, and `scripts/bootstrap.sh` says so rather than staying quiet -
  `doctor.sh` learned the hard way that a missing `jq` reads as a clean bill of
  health.
- Tailscale is not required. Without it Bothy resolves its own address to
  `127.0.0.1`, which works and is reachable only from the machine itself.

You can check the list before you have a checkout:

```sh
bothy doctor --pre
```

## Path A: you have git and you want to read the repository first

```sh
git clone https://github.com/YehudaBriskman/Bothy.git && cd Bothy
cp .env.example .env
just up
just urls
just doctor
```

**There is nothing to fill in.** Five credentials are generated for you - see
*What gets generated, and what you must keep* below.

## Path B: the installer, for a machine with no checkout at all

```sh
curl -fsSL https://raw.githubusercontent.com/YehudaBriskman/Bothy/main/scripts/bothy.sh -o bothy.sh
less bothy.sh
sh bothy.sh
```

`curl … | sh` works too, and it is the convenience rather than the documented
path. That ordering is argued at the top of
[`scripts/bothy.sh`](../../scripts/bothy.sh) and again in
[`SECURITY.md`](../../SECURITY.md): this ends at a program holding a Docker
socket, which is root-equivalent on the machine, and a pipe from a URL to a
shell should not be able to reach that in one step.

What the installer actually does, and the list is short on purpose:

1. checks that `git`, `curl` and `bash` exist - only those three, because it
   delegates the full list to the checkout it is about to make;
2. clones the repository and **verifies the tag against a commit id baked into
   the script** (`BOTHY_PIN_VERSION` / `BOTHY_PIN_SHA`), refusing and deleting
   its own clone if they disagree;
3. copies `scripts/bothy` to `~/.local/bin/bothy` and records the checkout path
   in `$XDG_CONFIG_HOME/bothy/config`, falling back to `~/.config`;
4. prints `bothy init` - **and does not run it.**

It never uses sudo, refuses to run under sudo, refuses a `BOTHY_DIR` outside
`$HOME`, and writes exactly three paths. `sh bothy.sh --dry-run` names all of
them and touches nothing.

> [!note] Why a commit id and not a checksum
> The release carries no assets of its own, and GitHub's auto-generated source
> tarballs are not byte-stable - projects have published a checksum for one and
> had it go wrong under them with no commit landing. A git commit id is already
> a checksum over the whole tree, verified by git on every object it writes. It
> proves the tree is the one this installer was published against. It proves
> nothing about whether the installer itself is genuine, which is what reading
> it first is for.

Then, on the machine, having read what you are about to run:

```sh
bothy init            # defaults to ~/bothy
```

`init` re-runs the prerequisite check, clones if it has not already, installs
`just`, copies `.env.example` to `.env`, runs `just up`, and finishes by
printing `just urls`.

## What `just up` does

`up` depends on `bootstrap`, and that is load-bearing rather than tidy: on a
fresh clone, four gitignored files that nothing creates are missing and
Prometheus is started with `--web.config.file` pointing at one of them. The
failure is not a message, it is a container that will not come up. The rule the
repository states about itself applies - if a step can be forgotten, put it
somewhere it cannot be skipped.

[`scripts/bootstrap.sh`](../../scripts/bootstrap.sh) runs in three phases and
prints `created` or `already present` for every action, so a second run is
*seen* to be a no-op rather than assumed to be one:

- **preflight** changes nothing and every failure names its fix;
- **create** makes the directories the writing services need, including the two
  snapshot directories that the file and config tiers refuse to start without;
- **generate** writes the credentials and the two Prometheus files.

Then the stack comes up in dependency order:
`network`, `up-edge`, `up-data`, `up-auth`, `up-monitoring`, `up-apps`.

Data before auth is a bug fix rather than a preference. Keycloak's database is
created by a one-shot inside the *shared* Postgres, which lives in a different
compose project, so `depends_on` cannot reach it and the script waits on
`pg_isready` instead - and a wait cannot help when the thing waited for has not
been started yet. On a genuinely fresh box with auth first, that one-shot spent
a minute failing to resolve `postgres`, exited 2, and took `just up` with it. It
never showed up on a developer machine because Postgres was already running from
the previous `just up`, every time.

> [!warning] Always `just`, never `docker compose` directly
> `just` loads the root `.env` through `set dotenv-load`. `docker compose` looks
> for a `.env` beside the compose file it was handed, finds none, and either
> falls back to an insecure default or aborts on a required variable.

## What gets generated, and what you must keep

Five credentials are generated when they are blank or still hold a
`.env.example` placeholder. The list has one definition, in
[`scripts/lib/bootstrap-keys.sh`](../../scripts/lib/bootstrap-keys.sh), shared
between `bootstrap` and the `up` recipe:

| Key | What it is |
|---|---|
| `POSTGRES_PASSWORD` | the shared dev database |
| `KEYCLOAK_DB_PASSWORD` | Keycloak's own database, in that same Postgres |
| `OAUTH2_COOKIE_SECRET` | signs the SSO session cookie |
| `KEYCLOAK_OAUTH2_CLIENT_SECRET` | the OIDC client secret, consumed at both ends |
| `DEV_LOGIN_PASSWORD` | the password a human types |

Bootstrap also resolves `BOX_IP` if it is still the shipped placeholder, and
writes `PUID`/`PGID` when your uid is not 1000.

Three properties are worth knowing before you go looking for a rotate button:

- **The values are never printed.** Only key names. This runs in CI and into
  scrollback that outlives the session.
- **They are never overwritten, and `--force` does not change that.**
  `POSTGRES_PASSWORD` and `KEYCLOAK_DB_PASSWORD` are baked into their database
  volumes at first start, so regenerating one locks you out of your own data
  with no error that mentions the script. Rotation is a real operation with a
  real order, documented per key in [`.env.example`](../../.env.example).
- **`.env` is gitignored and exists in exactly one place.** Losing it loses
  every credential on the box. The nightly backup copies it; the backups sit on
  the same disk they protect, which is not solved.

`DEV_LOGIN_PASSWORD` is generated as 24 alphanumeric characters rather than
base64, deliberately: it is the one a person types into a login form, far more
often than it needs to be strong once, and a 44-character string containing `-`
and `_` is a password people copy wrong.

Two values you may still want to set, neither of which blocks a first start:

- **`BOX_IP`** - the address this box answers on. Keycloak's issuer is built
  from it, so changing it later means re-running `just up-auth` or every login
  fails with a mismatch nobody can read from the error.
- **`DEV_LOGIN_USER`** - your login, `dev@example.com` by default. It must be an
  email address, because Keycloak here logs in by email and bootstrap refuses a
  value without an `@` in it.

## Reaching it

```sh
just urls
```

Start at `http://<node-ip>/`. Every browser-facing service publishes its own
host port:

| Port | Service |
|---|---|
| 80 | Traefik, which serves Bothy on the catch-all and the `/-/api/*` data plane |
| 8100 | the sandbox origin - raw file bytes only, and nothing else may ever be routed here |
| 8090 | Keycloak, admin console at `/admin` |
| 3000 | Grafana |
| 9090 | Prometheus |
| 3100 | Loki - API only, a 404 at `/` is normal |
| 8082 | cAdvisor |
| 9100 | node-exporter |

Postgres binds to loopback only and is never routed. Reach it over an SSH
tunnel; `just urls` prints the command with the right address in it.

> [!caution] A 200 proves nothing about routing
> The portal's catch-all answers *every* unmatched request on `:80` with its own
> HTML - from any hostname, from the bare IP, for any path no other rule matched.
> A service you believe you routed can be dead while `curl` reports a cheerful
> 200 and a page full of somebody else's markup. Assert on content, never on a
> status code. `just verify` does exactly that.

## Machines that are not WSL2 Ubuntu

Bothy is built and run on WSL2 / Ubuntu 24.04 and CI installs it on
`ubuntu-latest`. Two other shapes are coded for, and it is worth being precise
about how well each is covered.

**Ordinary Linux.** This is the case CI proves. What is genuinely WSL-specific
is not Bothy but the host: WSL2 destroys its VM sixty seconds after the last
Windows-side client disconnects, taking Docker and every container with it, so
that box holds itself open with a Windows scheduled task. On a normal Linux
machine none of that applies. The systemd units in
[`host/`](../../host/README.md) - the nightly backup timer in particular - are
copies of host configuration that git cannot see; nothing in `just up` installs
them, so on a fresh machine the nightly backup does not exist until you install
the timer yourself.

**macOS.** Bothy claims macOS and CI never runs there, so read this as intent
rather than as a tested guarantee. Three things are handled explicitly:

- `scripts/bothy` avoids every bash 4 construct because macOS ships bash 3.2,
  where an associative array or `${x,,}` fails at *parse* time and the error
  names a line that looks fine. `scripts/checks/bash32.sh` enforces it.
- `bootstrap` refuses a checkout outside `$HOME`, `/tmp`, `/private` or
  `/Volumes`, because Docker Desktop only bind-mounts from a shared root and the
  failure otherwise arrives at mount time with an error that never mentions file
  sharing.
- `PUID`/`PGID` are written from your own uid. The first macOS account is 501
  and a GitHub runner is 1001; the three services that write into bind mounts
  used to be hardcoded to `1000:1000`, which made Bothy installable only by
  somebody who happened to *be* uid 1000. The failure was silent: the container
  starts, its writes fail, and the tier looks broken.

If you install as root, `PUID` deliberately stays 1000 and the bind-mounted
directories are chowned instead. A root process holding container control is a
straight path from "restart a container" to the host, and
`apps/bothy-control/checks/grants.py` asserts that service is not root.

## Living with it

```sh
bothy upgrade      # git pull --ff-only, then just up. No down, no -v.
bothy download     # pre-fetch every image, so a later up needs no network
bothy version      # what this checkout is
just doctor        # containers, Prometheus targets, disk, backup freshness
just verify        # 23 checks that the edge still routes the way it claims
just portability   # what in the tree is tied to one machine
```

`bothy upgrade` deliberately has no `down` in it: the upgrade CI tier asserts
that an upgrade preserves your data and does not recreate volumes, and a `down`
would quietly break that. The CLI copy in `~/.local/bin` is a *copy*, not a
symlink into the checkout, so re-run the installer to refresh it after an
upgrade - a symlink would break the day somebody moved the checkout, with
"command not found" for a program they can see on their PATH.

Everything the CLI does not implement natively is handed straight to the
justfile; `scripts/checks/cli-commands.sh` asserts every subcommand resolves to
something that exists, so a renamed recipe fails CI instead of failing a person.

## Removing it

The installer's three paths - `~/.local/bin/bothy`, the checkout, and the config
file - are all removable by hand. Containers and volumes are `just down` and, if
you mean it, `just nuke`, which deletes every data volume and is the one recipe
that asks for confirmation because it sits one keystroke from `just down` in the
list.

## Next

- [The `bothy` command](the-cli.md) - what `init` did, and what the CLI does after it
- [The files you will actually edit](configuring.md)
- [Operating it from the console](the-console.md)
