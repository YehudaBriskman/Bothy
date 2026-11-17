# `bothy install`: one binary, no checkout (Bivvy on Docker Compose)

_Status: **design plus a working prototype, proven twice in the lab VM on 2026-11-17** against a **faked**
release (local registry, section 9). Not proven against real GHCR images, real release assets, a WSL host or
the live box. Companion to `install-and-bootstrap.md` (the k3s path, still a design) and
`cli-and-control-plane.md` s2 and s5 (the binary and its verbs)._

## 1. The goal and the flow

The owner's goal: Bothy installs like Chromium or VS Code. The user downloads **one binary** (the Go `bothy`
CLI) and runs `bothy install`. No git checkout, no Go, Python or Node, nothing built on the machine.

```
curl -fsSLO https://github.com/<owner>/Bothy/releases/download/v2026.11.0/bothy_linux_amd64.tar.gz   # 1. get the binary
tar -xzf ... && install bothy ~/.local/bin/                                                           #    (bothy.sh does this today; later too)
bothy install --dry-run          # 2. read what it will do
bothy install                    # 3. do it
```

`bothy install` then:

1. fetches `release-manifest.json` and `checksums.txt` from **the release that matches the binary's own
   version** and refuses unless the manifest's sha256 equals its line in `checksums.txt` (section 5);
2. runs **preflight**, read-only (section 4) and stops with the exact fix for anything that fails;
3. prints the **plan**, every action, marked `do` or `skip` (a `skip` is already true on this machine);
4. applies it: directories, secrets, receipt, stack files, `docker pull <ref>@sha256:...` for each image,
   `docker compose up -d --wait`, then **verifies bytes** (section 7);
5. prints `Bivvy is up: http://<addr>:<port>/`.

`bothy install --dry-run` stops after step 3 and changes nothing (the only commands it runs are read-only
`docker version`, `image inspect` and `compose ps`). Re-running is safe and a no-op once the box matches.

## 2. What is embedded in the binary, and the one source of truth

The binary carries the **stack definition** for each mode it can install, via `go:embed`:
`cli/internal/install/stack/<mode>/{compose.yml, stack.json, files/...}`. It carries **no secret, no image,
no release number** (the version is stamped by ldflags; the manifest is fetched).

**These files are generated, never edited.** The single source is:

- `stack/modes.yml`: per mode, which compose files and which **services** it runs, which host ports it
  publishes, which host paths a service may bind, which static files ship, and the bytes check;
- the repo's own compose files it names (`edge/compose.yml`, `apps/bothy-web/compose.yml`).

`go generate ./...` in `cli/` (already part of `just cli-check`) runs `cli/cmd/stackgen`, which applies **generic**
transforms to the selected services (`cli/internal/stackgen`): drop `build`, `container_name`, `pull_policy`;
the image becomes `${BOTHY_IMAGE_<NAME>}` (the installer fills it with a digest from the manifest); published
ports are replaced by exactly the rows in `modes.yml`, bound to `${BOTHY_BIND}`; a bind mount must be an
allow-listed path or a relative path (rewritten to `./<service>/<path>` under the install root), anything
else (`../..:/repos/stacks`, `${HOME}/...`) is a **generate-time error**, not a silent leak; a network used by
fewer than two selected services is dropped and the rest become `bothy-<name>` and stop being `external`;
a service with no memory limit is refused.

**Drift check:** `TestEmbeddedStackIsCurrent` regenerates in memory from the repo and compares with the
embedded bytes (both directions: stale and orphaned). It runs in CI's `go test ./...`. **Adding a service
to a mode is a change to `stack/modes.yml` (and its compose file), then `go generate`. No Go edit.**
`TestGenerateAddsServiceFromData` proves that on a made-up repo.

## 3. Directory layout, modes, root

Default is **user scope: no root anywhere**.

| What | Path | Mode |
|---|---|---|
| install root (`--root`, must be named `bothy`) | `${XDG_DATA_HOME:-~/.local/share}/bothy/` | 0755 |
| generated stack | `<root>/stack/{compose.yml, .env, <service>/...}` | `.env` 0600, rest 0644/0755 |
| bind sources for services (`traefik/dynamic`, `bothy-web/data`) | under `<root>/stack/` | 0755, **created by us** so Docker never creates them as root |
| receipt | `<root>/receipt.json` | 0600, written atomically |
| config and secrets (`--config-dir`, named `bothy`) | `${XDG_CONFIG_HOME:-~/.config}/bothy/secrets/` | dir **0700**, `master.key` **0600** |

`master.key` is 32 random bytes from `crypto/rand`, generated **on this machine**, never printed, never
rotated by a re-run. **Nothing consumes it yet** in Bivvy-on-Compose (the settings store and login are not in
the mini stack); it is generated now so the layout and modes are settled before anything depends on it.

A **system scope** (`/var/lib/bothy`, `/etc/bothy` 0700/0600, a systemd unit) is **designed, not built**: it is
the same code with different roots plus a root-owned install. It is what a headless server wants (start at
boot is already given by `restart: unless-stopped` plus the Docker daemon being enabled).

**What needs root, exactly:** nothing that `bothy install` does. Root is needed only for things the person does
**before** it, and the preflight names them and asks: installing Docker, `usermod -aG docker $USER` (then log
out and in), and `systemctl start docker`. **bothy never runs `sudo`** and `SysHost.Run` refuses any
command but `docker` (tested). Running as root is allowed with a warning (files land in root's home).

## 4. Preflight

Read-only; never changes anything; each line has a fix in words.

| Check | Rule | Fix text names |
|---|---|---|
| os/arch | linux, amd64 or arm64 | (macOS and Windows hosts are a later step) |
| Docker present and reachable | `docker version` works; **Engine >= 25.0** (the stack's healthchecks use `start_interval`) | install Docker (we do not: root); `usermod -aG docker`; start the daemon |
| Compose | `docker compose version` >= 2.24 | `apt install docker-compose-v2` |
| rootless Docker | refused (the edge mounts `/var/run/docker.sock`) | |
| **RAM gate (D13)** | `MemAvailable` >= sum of the stack's container limits + `reserve_mib` (mini: 64+128+512 = **704 MiB**). The k3s 4 GiB floor is not this installer's: it is the Compose runtime, and says so | free memory |
| disk | >= 2 GiB free where the root will be; refuse 9p, nfs, cifs, fuse | `--root` elsewhere |
| ports | the kernel's TCP table (`/proc/net/tcp*`), not a `bind()` test: Docker binds as root, so an unprivileged `bind(80)` lies | `--port` |
| manifest fits | every service has an entry (images or third_party) and `linux/<arch>` is in `platforms` | |

Tested by `TestPreflight` with a fake host: macOS, riscv, root, old Docker, no Docker, not in the docker group,
daemon down, no compose, rootless, RAM, disk, 9p, port taken on the wildcard and on the same address, a
listener on another address (not a conflict), the install holding its own port on a re-run.

## 5. Trust: how "deploy only what the released version says" is kept

The binary installs **exactly the release it belongs to**. `VerifyManifest` (tested):

1. `release-manifest.json`'s sha256 must equal its line in `checksums.txt` (the file the release **attests**;
   this prototype does **not** verify the attestation itself, see Q2);
2. if the binary was built with `-ldflags "-X .../install.PinnedManifestSHA=<hex>"`, it must equal that too
   (the same pin-the-hash idea as `bothy.sh`'s commit pin, which `security-model.md` calls the control that matters);
3. `manifest.version` must equal the binary's version; a `dev` build refuses (it has no release);
4. unknown JSON fields, schema != 1, a non-40-hex commit, or any image reference without
   `@sha256:<64 hex>` are refused. **Every image is pulled by digest, never a tag, and the pull is followed
   by a check that the local image carries that digest.** Compose runs with `pull_policy: never`, so it can
   never decide to fetch something itself.
5. A **downgrade** (manifest older than the receipt) is refused unless `--allow-downgrade`.

Plain `http://` for release metadata is refused. Fetches are capped at 1 MiB.

## 6. Idempotence, resume, failure, rollback

The plan is computed from the **actual machine** (files byte-compared, images inspected, `compose ps`) plus the
receipt, so a re-run needs no special mode: finished steps are `skip`.

- Order: `dirs`, `secrets`, `receipt` (written `in-progress` **before** anything starts), `files`, one `pull`
  per image, `up`, `verify`; then the receipt is flipped to `complete`.
- **Resumable:** any failure stops at that step, records `last_error` in the receipt, and prints
  "run `bothy install` again to resume, or `bothy uninstall`". Proven in the lab with a manifest naming a
  digest the registry does not have: the pull failed, nothing was running, the re-run with the good manifest
  skipped dirs/secrets/pulls and finished.
- **Rollback is narrow:** if `up` or `verify` fails on a **first** install, `docker compose down
  --remove-orphans` is run (no volumes). On an upgrade nothing is rolled back (the old containers are the
  last good state until `up` replaces them; a failed `up` leaves compose's own state: this is **not** a
  tested rollback to the previous release, see section 11). Files and secrets are never deleted by a failure.
- **Upgrade = re-run with a newer binary's release:** the new digests make `pull`, `files` and `up` `do`, the
  rest `skip`. Unit-tested for the downgrade guard; the upgrade path itself is **not run in the lab**.

## 7. Verify by bytes (the portal catch-all trap)

The edge's catch-all answers **200 to every unrouted path** (measured again in the lab: `/-/api/x` gave
200). So a status code proves nothing, and `verify` checks content, from `stack/modes.yml`:

- `GET /version.json` must be JSON whose `revision` equals the manifest's `commit` (the web image is built with
  `REVISION=<commit>`; **the release build must do the same**, this is a requirement on D34);
- `GET /` through the edge must be **byte-identical** to `/usr/share/nginx/html/index.html` read with
  `docker compose exec` inside `bothy-web`. A catch-all HTML page where JSON was expected fails with a message
  saying so (`TestApply...`).

## 8. `bothy uninstall`, and `bothy update`

`bothy uninstall` (always prints its plan; `--dry-run` stops there): `compose down --remove-orphans`, delete
the **generated** files, remove the stack directories **only if empty** (`os.Remove`, never recursive: a
directory with content is kept), delete the receipt. **Kept: `master.key`, any data directory with content,
pulled images.** `--purge` additionally deletes secrets, images and the install root, and **only after the
person types `delete bothy data`**; a wrong answer deletes nothing (proven in the lab). The purge refuses a
path that is not a plain directory named `bothy` (or `secrets`), is `$HOME` or is `/`.

**`bothy update`** (not built; the handoff):
- *Binary:* the user (or `bothy.sh`) fetches the newer binary; `bothy update` later wraps that download,
  verifying it against `checksums.txt` and the attestation.
- *Stack:* `bothy install` from the newer binary **is** the stack update (section 6). One code path.
- *The web updater (`apps/bothy-ops/updater`)* keeps its rule, "deploy only what the pinned version says",
  by reading its pins from a different place when there is no git checkout: the **verified manifest recorded
  in the receipt** instead of `main`'s compose files. `discover` asks the release feed for a newer release,
  `apply` downloads that release's manifest and calls the same `Install` plan with a typed confirmation for
  anything the catalog marks `manual`. It still never replaces itself in the same run, and its classes and
  `updates.toml` policy are unchanged. This needs the updater to run where Docker and the binary are
  reachable; whether that is the host (as today) or the binary itself is Q4.

## 9. How the lab proof faked the release

Real GHCR images do not exist yet, so `lab/install-proof/fake-release.sh` (runs **inside the guest**):
starts `registry:2` as container `fake-ghcr` on `127.0.0.1:5000`, builds `apps/bothy-web` from a
`git archive` tarball with `REVISION=<commit>`, pushes it, reads the pushed **digest**, **removes the local
image**, and writes a manifest whose `images.bothy-web.ref` is `localhost:5000/bothy-web@sha256:...` and whose
`third_party.traefik.ref` is the repo's own pinned Traefik (`traefik:v3.7.18@sha256:9c437ac...`, really pulled
from Docker Hub), plus `checksums.txt` (`sha256sum release-manifest.json`). So the install **really pulls by
digest over the network**; what is fake is only who published the image and that `checksums.txt` is not
attested or signed. The binary is the **only** thing copied in; the two release files stand for the release
assets. `lab/install-proof/proof.sh` is the assertion script.

## 10. Results (lab, 2026-11-17)

Guest: Ubuntu 24.04, kernel 6.8.0-147, 4 GiB, 2 vCPU (`lab-mid`), only `docker.io` 29.1.3, `docker-compose-v2`
2.40.3, `docker-buildx` from apt (about 62 s); no Go, Node or Python toolchain used (the stock image's
`git` and `python3` exist but the installer does not call them). Binary: 9.2 MB, static, copied in.

| Step | Result |
|---|---|
| preflight with no docker / not in docker group / daemon unreachable | `fail docker` with the fix text, nothing created |
| `bothy install --dry-run --bind 0.0.0.0` | rc 0, 8 `do` lines, `~/.local/share/bothy` and `~/.config/bothy` not created |
| `bothy install --bind 0.0.0.0` (manual, first VM) | **16.6 s** (pull web 2.0 s, pull Traefik 7.6 s, `up --wait` 6.5 s), rc 0 |
| bytes | `GET /` from the **host** via the lab forward (`127.0.0.1:18082`) 200, 5299 bytes, sha256 `3aa71460...3c3a8`, identical to the file inside the container; `/version.json` `{"revision":"3fbd7dea..."}` = the manifest commit. `/-/api/x` also 200 (the trap) |
| container memory | Traefik 17.8 MiB / 128, bothy-web 3.3 MiB / 64; guest `free` used 567-671 MiB with the OS and the fake registry |
| modes | `master.key` 0600, `secrets` and config dir 0700, `.env` and receipt 0600 |
| re-run | **0.5-0.9 s**, every line `skip`, "nothing to do", verify still ran, key unchanged |
| `uninstall --dry-run`, then `uninstall` | containers and network gone, `master.key` kept, receipt and compose.yml gone, curl refused |
| reinstall | `secrets` skipped, same key reused |
| `uninstall --purge` with `yes` | "aborted: nothing was changed", containers still up, key kept |
| `uninstall --purge` with `delete bothy data` | root and secrets gone, both images removed |
| injected failure (manifest naming an absent digest) | pull failed, receipt `in-progress` with `last_error`, nothing running; re-run with the good manifest finished (skipped 4 steps) |

**Two scripted passes of `proof.sh`, both `PROOF PASSED (14 checks)`:** pass A on the first guest (install 21.7 s),
pass B on a **freshly reset guest** (docker installed again, fake release rebuilt, install 12.1 s, re-run 0.5 s).

**What failed or was fixed along the way (honest list):**
1. The first digest-reference regex required a registry path, so the bare `traefik@sha256:...` form the
   contract allows was refused. Caught by the unit tests, widened (a `:tag` may ride along; no digest is
   still refused).
2. After a plain uninstall the empty install root and (after purge) the empty config dir were left behind.
   Found in the lab, fixed (both removed when empty).
3. A failed step prints its error twice (once in the plan output, once from the CLI). Cosmetic, **not fixed**.
4. The container is called `bothy-bothy-web-1` (project `bothy` + service `bothy-web`). Harmless, not pretty.
5. Not a failure but a limit: the lab guest cannot test the real GHCR path, so pass criteria never involved
   image attestation or a cold registry.

Unit tests (`cli/internal/install`, all in `just cli-check`, which is green): drift both ways, adding a service
from data, a host bind refused, manifest verification (tampered, wrong pin, other version, dev build, missing
line, tags, unknown fields, schema), 14 preflight cases, dry run prints every action and runs no write
command, preflight failure changes nothing, a mismatched binary is refused, a full apply against fakes (file
modes, key never printed or rotated, receipt, resume after a failed `up` with the rollback `down`, re-run
no-op, catch-all HTML rejected, downgrade refused, uninstall keeps secrets, purge needs the phrase), `SysHost`
refuses `sudo`, and **`internal/mcpserver` has no dependency on `internal/install` or `stackgen`** (the slice-1
rule: the read-only MCP server gains no install or write tool; install is a CLI verb outside the catalog).

## 11. Decisions taken

| # | Decision | Reason |
|---|---|---|
| I1 | The binary embeds a **generated** stack; `stack/modes.yml` plus the repo's compose files are the one source; a test fails on drift | one source of truth; adding a service needs no Go |
| I2 | The generator refuses unknown bind mounts and services with no memory limit | the repo compose files assume a checkout; a silent `../..` mount on a user's machine is the worst failure |
| I3 | User scope by default (`~/.local/share/bothy`, `~/.config/bothy`), no root | an installer that needs no root has no root surprises; system scope is the same code later |
| I4 | `bothy` never runs `sudo` and runs only `docker` | "no sudo surprises" enforced in the one place commands run, and tested |
| I5 | Docker is a prerequisite we check, not something we install | installing Docker needs root and distro choices; we print the exact command |
| I6 | Every image by `@sha256`, pulled by the installer, compose `pull_policy: never`, digest re-checked | the updater rule "only what the release says"; no tag can drift |
| I7 | Trust anchor: manifest sha256 in `checksums.txt`, optional ldflags pin, version must equal the binary's | the binary installs exactly its own release; the pin is the `bothy.sh` idea, kept |
| I8 | Default bind `127.0.0.1`, `--bind 0.0.0.0` explicit | first sign-in is plain HTTP (`modes-and-modules.md` s3); LAN exposure should be a choice |
| I9 | Default port 80 (the stack's contract), `--port` to move it | the portal catch-all lives on 80; a collision is caught in preflight |
| I10 | Compose project `bothy`, network `bothy-devnet`, no `container_name` | cannot collide with the user's other containers or the dev stack's `devnet` |
| I11 | The receipt is written `in-progress` before anything starts and flipped to `complete` last | resume and uninstall both need to know what was begun |
| I12 | Resume is "run it again", not a flag | the plan is derived from real state, so there is one code path |
| I13 | Roll back only what a first install started (`compose down`, no volumes); never delete files or secrets on failure | a partial install is resumable; deleting on failure would destroy the evidence and the key |
| I14 | Uninstall keeps secrets, data and images; `--purge` needs the typed phrase `delete bothy data` and only deletes dirs named `bothy`/`secrets` | the one unrecoverable mistake is deleting data |
| I15 | Verify by bytes, driven by `modes.yml` | the catch-all makes any status code meaningless |
| I16 | Downgrade refused | updater rule; a stale manifest must not silently roll the box back |
| I17 | `master.key` generated now, though unused | settle the layout and modes before a module depends on it |
| I18 | Install and uninstall are CLI verbs outside the catalog, and the MCP server cannot reach them | slice-1 rule, enforced by a dependency test |
| I19 | The mini stack in this prototype is **edge (Traefik) plus the web portal** only | the smallest thing that proves the whole path; `files`, `login` and `network` need decisions below |

## 12. Open questions that truly need the owner

- **Q1. Traefik reads `/var/run/docker.sock` (the docker provider).** That is today's design and the most
  powerful mount on the box. Installed mode could instead generate a **file-provider** config from the labels
  (no socket in the edge), at the cost of a generator step and no auto-discovery of later modules. Keep the
  socket for now, or build the file-provider edge before this ships to anyone else?
- **Q2. Who verifies the attestation on `checksums.txt`?** The prototype trusts the HTTPS origin plus the
  hash. Options: shell out to `gh attestation verify` when present; vendor Sigstore verification into the
  binary (more code, one more dependency); or accept the optional ldflags pin as the only anchor in v1.
- **Q3. What is Bivvy on Compose, actually?** Files, login and the read-only network page are in the module
  table, but files needs a roots policy for a machine with no `~/stacks` and no notes repo, login is not
  built, and ops needs the host daemon. Is "portal and edge that answers" an acceptable first release of
  `bothy install`, with those added module by module, or must `files` ship in the first one?
- **Q4. Where does the updater run on an installed box?** On the host as a timer calling the binary (closest
  to today), or as a `bothy update` verb run by the user. This decides whether the web Settings > Updates
  page can apply on a binary install at all.

## 13. Prototype versus proven, and next steps

**Proven in the lab (twice):** the whole lifecycle in section 10 on a clean Ubuntu 24.04 guest with only Docker and
the binary, against the faked release.

**Prototype only:** the mini stack's scope (Q3); user scope only; the upgrade path (a second release) is
unit-tested but **not run in the VM**; rollback after a failed `up` on a first install is unit-tested with
fakes and **not triggered in the VM** (only a failed pull was); no `bothy update` verb; no attestation check;
`--mode` accepts only `mini`; amd64 only was exercised.

**Not verified at all:** real GHCR images and release assets; arm64; a WSL host (the keepalive, `docker.sock` path
and the 4 GiB floor all differ there); `lab-mini` (2 GiB: the RAM gate arithmetic passes at 704 MiB needed, but
it was not run); a host where port 80 is taken by another Docker container; rootless Docker (refused, untested);
Docker `iptables`/`nft` coexistence (`testing-and-ci.md` 2b); the live box (and it must not be, per the go/no-go).

**Exact next steps**
1. D34 side: the release must publish `release-manifest.json` and `checksums.txt` as assets of the same tag,
   `checksums.txt` must contain a `release-manifest.json` line, `bothy-web` must be built with
   `REVISION=<commit>` and `/version.json`, and `images`/`third_party` keys must be the image's last path segment
   (`bothy-web`, `traefik`). Then stamp `PinnedManifestSHA` in the release build.
2. Repeat the VM proof against the real GHCR images (delete `fake-release.sh` from the loop; keep `proof.sh`).
3. Decide Q1 to Q4; then add `bothy-files` (roots policy, `read_only` mounts) as the second module through
   `stack/modes.yml` only, which also exercises the "no Go" claim on a real service.
4. Run the upgrade (two releases) and a forced `up` failure on `lab-mini` in the VM; add the arm64 guest.
5. Add `bothy update` and the updater's release-manifest source (section 8), and the system scope.
6. Wire `bothy.sh` to download the binary (checksum-verified) instead of cloning, so "one binary" is true
   for the first step too.

## 14. Files

`stack/modes.yml`; `cli/cmd/stackgen`; `cli/internal/stackgen`; `cli/internal/install/{embed,manifest,preflight,
install,uninstall,host}.go` and `stack/` (generated); `cli/internal/cli/install_cmd.go`;
`lab/install-proof/{fake-release,proof}.sh`.
