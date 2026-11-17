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

1. `release-manifest.json`'s sha256 must equal its line in `checksums.txt` (the file the release **attests**, and
   which the release's last job completes with that line: `distribution-and-packaging.md` 8.1;
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

**`bothy update`** (built, 2026-11-17; user-run, decision Q4). The stack-apply step installs the release **the
running binary belongs to** (the stack definition is embedded, so a newer release arrives as a newer binary). Moving
to a newer release is the binary self-update in section 8b, which ends by running this step with the new binary
(`--this-release`, which is also what `--manifest`/`--checksums` imply). The bare verb `bothy update` is this; the
catalog nouns `update status|plan|history` are unchanged.
- *Verification, the same as install:* same-version manifest over HTTPS, its line in `checksums.txt`, then
  `gh attestation verify` when a working `gh` is present (one function, `checkAttestation`; skip-versus-refuse
  rules in 10d); otherwise it prints the exact command and says **skipped**. A downgrade is refused unless `--allow-downgrade`.
- *`--check`* prints what would change (per image variable: old digest to new, or `unchanged`) and the plan, and
  changes nothing (receipt, `.env`, containers all byte-identical, proven). `--dry-run` is the same.
- *Apply:* the generated files and the receipt are copied to `<root>/previous/`, then the usual plan runs (receipt,
  files, pull by digest, `compose up -d --wait --pull never`, verify by bytes). Containers whose digest did not
  change are not restarted.
- *Rollback:* any failure after the rollback point (a digest the registry lacks, a container that never gets
  healthy within `--wait-timeout`, bytes that do not match) restores the previous files, runs `up --wait` on the
  **previous receipt's digests** (the images are still local), verifies the **previous commit by bytes**, and
  rewrites the receipt as before plus `last_update_error`. If the rollback itself fails, it says so, keeps
  `previous/`, and points at `bothy install` with the previous binary. Two generations are kept; an update
  removes the image of the release before the previous one when nothing else uses it.
- *Not done:* the web updater (`apps/bothy-ops/updater`) still reads `main`'s pins. Having it read the
  receipt's manifest and call the same code is a later slice. Install, update and uninstall remain outside the
  MCP catalog (dependency test).

### 8b. `bothy update` finds and installs a newer release (built 2026-11-17, offline-tested only)

```
bothy update --check          is there a newer stable release? changes nothing, downloads nothing
bothy update                  newer: verify, replace this binary, then update the box with it
bothy update --to v2026.12.0  a specific stable release (older than this binary needs --allow-downgrade)
bothy update --this-release   skip GitHub: re-apply the release THIS binary belongs to (old behaviour)
```

*Discovery.* `GET https://api.github.com/repos/YehudaBriskman/Bothy/releases?per_page=30`, unauthenticated.
Drafts, prereleases and tags that are not strict CalVer (`vYYYY.M.N`, month 1-12; `v2026.11.1-rc1` and
`v2026.11.01` are not versions) are ignored; the **highest** version wins, not the newest-created. Same version: the
binary is up to date and `update` falls through to the old same-version stack re-apply. A latest older than the
binary: nothing to do. `--to` older than the binary: refused without `--allow-downgrade`. Rate limit (403 with
`X-RateLimit-Remaining: 0`, or 429) is its own error naming the reset time; a transport failure says GitHub is
unreachable and names `--this-release` as the offline way out; both change nothing. `--channel` is not built:
there is one channel (stable); a second would be a second tag rule, not new code paths.

*Order, and what is checked at each step.* (1) receipt exists and the binary is a release build; (2) discovery;
(3) `checksums.txt` and `release-manifest.json` for the **tag** are fetched from
`github.com/<repo>/releases/download/<tag>/`; (4) `VerifyManifest` with the **target** version: the manifest's
sha256 equals its line in `checksums.txt`, and `manifest.version` equals the tag (a release whose manifest says
another version is refused); (5) `checkAttestation` on `checksums.txt` (skip-versus-refuse rules of 10d,
`--require-attestation` honoured); (6) the platform archive `bothy_<ver>_<os>_<arch>.tar.gz|.zip` is streamed to
a temp file and hashed on the way; the hash must equal its line in `checksums.txt`; a cut connection, an oversize
body (200 MiB) or a mismatch deletes it; (7) it must hold exactly one file named `bothy`/`bothy.exe` (no path, no
second entry), unpacked next to the running binary (same directory, so the rename is on one filesystem) with a
300 MiB cap; (8) the unpacked binary is run once as `bothy version` and must report the target version; (9) swap;
(10) the **new** binary is run as `update --this-release` with the same `--root/--config-dir/--wait-timeout/
--allow-downgrade/--require-attestation`, so the stack definition applied is the one embedded in the release it
belongs to, with the existing receipt, pull-by-digest, verify-by-bytes and rollback; (11) if (10) fails (its own
rollback has already restored the stack) the old binary is put back, so the verb moves both or neither.
Steps 1-8 change nothing on disk except temp files (removed on every exit path; tested).

*Swap.* Unix: the old binary is copied to `bothy.prev` (via `bothy.prev.tmp` and a rename), then the new one is
renamed over `bothy`: atomic, no instant without a binary, a running process keeps its inode. Windows (a running
exe cannot be overwritten but can be renamed): `bothy` -> `bothy.prev`, then new -> `bothy`; if the second rename
fails the first is undone. That order is unit-tested with the Windows branch forced on Linux; it is **not run on
Windows**. If the directory is not writable the verb says so before downloading anything. One `bothy.prev` is kept
(the next update replaces it); to go back by hand, stop bothy and move `bothy.prev` over `bothy`.

*Packagers.* `install.Packager` (ldflags) non-empty means a package manager owns the binary: `--check` still
reports, but `bothy update` refuses to replace the binary and names the package manager. The release archives leave
it empty. A future deb/brew/winget build sets it and needs no other change; the web updater can call
`bothy update --this-release` (stack only) or the whole verb.

#### The trust model, stated plainly

What is trusted, in order: **(a)** TLS to `api.github.com` for **one string**, the tag name. Every later URL is
**built** from that validated tag (`github.com/<repo>/releases/download/<tag>/<asset>`); no URL from the API
response is ever followed, so a forged API response cannot redirect the download to another host or smuggle a path.
**(b)** TLS to `github.com` (and the CDN it redirects to) for `checksums.txt`, the manifest and the archive.
**(c)** The sha256 chain: manifest hash and archive hash are both lines in the `checksums.txt` fetched in (b), and
the images are pulled by digest from the manifest. **(d)** Only when a working, logged-in `gh` (2.49+) is present:
`gh attestation verify` says `checksums.txt` was produced by this repository's release workflow
(Sigstore/GitHub attestations). Without `gh` that step is **skipped, loudly**, unless `--require-attestation`.

What an attacker can and cannot do:

- *Controls only the API response* (a hostile proxy that can answer `api.github.com` but cannot also serve
  `github.com` over valid TLS): can hide a release (stay on the old one), name an older release (needs
  `--allow-downgrade`; the version refusal compares against the binary), name a tag that does not exist (404, nothing
  changes) or rate-limit us. Cannot make us run different bytes: the bytes come from the tag's own URLs.
- *Controls what `github.com` serves for the repository* (a compromised maintainer account or release, or a broken
  TLS trust store on the user's machine): **wins**, unless (d) is active. The sha256 chain starts from files served
  by the same place as the archive, so it detects corruption and a mismatched archive, **not** a malicious release.
  Only the attestation binds `checksums.txt` to the workflow that built it, and a maintainer who can push a release
  workflow change is the next link. There is no signature the user can check that is independent of GitHub.
- *Tampered archive or checksums.txt in transit or at rest, with the other left intact*: caught (archive vs its
  line; manifest vs its line; a manifest or archive swapped to a different version: version check).
- *A malicious release by the legitimate publisher*: not caught by anything here; it is the publisher's key.
- Releases from a **fork or another repo**: not reachable; the repository is a constant (`AttestRepo`).
- The ldflags `PinnedManifestSHA` does **not** apply to a different release than the running binary's, so it is not
  consulted in the self-update (it cannot be: the running binary was built before the new release existed).

Decision on a pinned signing mechanism: **not now, and nothing invented.** The first hop is TLS plus the GitHub
attestation, exactly as install already states (Q2). Two real options exist for later, both built on infrastructure
that already exists: (1) embed Sigstore verification (the `sigstore-go` library, with the trusted root and the
expected workflow identity `YehudaBriskman/Bothy`'s `release.yml` compiled in) so the check no longer needs `gh`;
the verifier already sits behind `checkAttestation`; (2) a project-held offline signing key (minisign/cosign key
pair) whose **public** key is compiled into every binary, so a release is trusted if signed by a key that is not
GitHub's. (2) would defeat the "GitHub is compromised" row above; it costs a key to guard and rotate. Until one is
built, `--require-attestation` plus `gh` is the strongest check the verb offers, and the honest default on a machine
without `gh` is sha256 over TLS.

**Unproven.** Everything above runs against a fake GitHub (`httptest`, two versions, TLS) and fake hosts; there has
been **no run against the real GitHub API or a real second release** (only v2026.11.1 exists), no run of the real
`gh attestation verify` inside this verb, no run of the swap on Windows or macOS, no run of the re-exec'd new binary
(the tests inject it; the real path is `exec <exe> update --this-release ...`), and the 60-requests-an-hour limit
and the `403`-with-header form are from GitHub's documentation, not observed. The web updater does not use any of this yet.

## 9. How the lab proof faked the release

Real GHCR images do not exist yet, so `lab/install-proof/fake-release.sh` (runs **inside the guest**):
starts `registry:2` as container `fake-ghcr` on `127.0.0.1:5000`, builds `apps/bothy-web` and `apps/bothy-files` from a
`git archive` tarball with `REVISION=<commit>`, pushes them, reads the pushed **digest**, **removes the local
image**, and writes a manifest whose `images.bothy-web.ref` is `localhost:5000/bothy-web@sha256:...` and whose
`third_party.traefik.ref` is the repo's own pinned Traefik (`traefik:v3.7.18@sha256:9c437ac...`, really pulled
from Docker Hub), plus `checksums.txt` (`sha256sum release-manifest.json`). So the install **really pulls by
digest over the network**; what is fake is only who published the image and that `checksums.txt` is not
attested or signed. The binary is the **only** thing copied in; the two release files stand for the release
assets. It now writes four releases: 2026.11.0 (base), 2026.11.1 (web image with a changed `index.html` and
`/version.json`), 2026.11.2 (web names a well-formed digest the registry lacks) and 2026.11.3 (web image whose
command is `sleep`: it starts and never becomes healthy). The four CLI binaries are the same source stamped with
each version (a release's stack travels inside its binary). `lab/install-proof/run-lab.sh` is the host-side driver
(builds, boots the guest through `lab.sh`, installs Docker by apt, copies everything in, runs both scripts);
`proof.sh` is the assertion script.

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

### 10b. Results of the second proof: socketless edge, files module, update, rollback (lab, 2026-11-17)

Guest `lab-mid` (2 vCPU, 4 GiB), same recipe. `proof.sh` is now 53 checks. Commands: `lab/install-proof/run-lab.sh lab-mid`
(then `lab/lab.sh down lab-mid`, `lab/lab.sh reset lab-mid`, run again for a clean guest). **Two full passes, both
`PROOF PASSED (53 checks)`**: pass 1 on a guest that an earlier aborted run had left with cached images (so its
pulls were not cold: said plainly), pass 2 on a **reset guest** (Docker installed again in 47 s, fake release
built in 109 s, proof 97 s, total 287 s). Before them one run stopped at check 12 because my assertion expected an
HTML doctype where nginx answered `405 Not Allowed`; the assertion was wrong, the stack was right.

| Check | Observed (reset guest) |
|---|---|
| install, 3 images (traefik, web, files) | **13.1 s**; re-run **0.7 s**, all `skip`, key unchanged |
| RAM gate | `960 MiB needed` = 128 + 64 + 256 (limits) + 512 reserve |
| portal bytes | `GET /` equals `index.html` inside the container; `/version.json` = commit A |
| edge has no Docker socket | `docker inspect` of Traefik: one bind, `.../traefik/dynamic -> /etc/traefik/dynamic ro`; no `docker.sock`; no container in the project mounts it |
| edge static config | `--providers.file.directory`, `--api=true`, no `providers.docker`, no `api.dashboard` |
| ports | docker publishes exactly `0.0.0.0:80->80/tcp` (Traefik); `ss` shows 22, 80 and the lab's own 5000 and loopback listeners; **nothing** on 8100, 8899, 8099, 8080 |
| internal entrypoint | `127.0.0.1:8899/ping` answers **inside** Traefik; `traefik:8899` from another container is refused |
| Traefik log | no error lines |
| files module through the edge | `/-/api/files/roots` = one root `notes`, `readOnly: true`; `/read` returns a file dropped in `<root>/stack/bothy-files/notes`; a `.env` there is labelled sensitive |
| files cannot write | `POST /-/api/files/write` is not routed (nginx's 405 from the portal catch-all answered), no file appeared; `touch` in the container's notes mount fails (`:ro`); `/raw` (sandbox origin) is not served on :80 |
| memory | Traefik 15 MiB / 128, bothy-web 3.4 / 64, bothy-files 19.6 / 256; guest `free` used 683 MiB with the registry |
| `update --check` A to B | "1 image(s) would change" (`BOTHY_IMAGE_BOTHY_WEB` changes, `..._FILES` unchanged); `.env`, receipt and web container id identical afterwards; no `previous/` |
| `update` A to B | **4.1 s**; `/version.json` is now commit B, served `/` carries the release marker and equals the new container's file; the files container was **not restarted**; receipt = B with `previous` = A; files still serve |
| downgrade | `bothy-2026.11.0 update` refused, nothing changed |
| forced failure 1: digest the registry lacks | pull fails in 72 ms, rollback, **1.5 s** in all; afterwards `/version.json`, served bytes, `.env` (byte for byte) and receipt are release B's, with `last_update_error`; 3 containers running |
| forced failure 2: container never healthy (`--wait-timeout 25`) | `up --wait` fails at 26 s ("application not healthy after 25s"), rollback, **42.2 s** in all; same assertions hold |
| uninstall | containers and networks gone; secret kept; receipt, generated files and `previous/` gone; the user's notes kept; reinstall reuses the secret |
| purge | `yes` deletes nothing and leaves the stack running; `delete bothy data` removes root, notes, secrets and the pulled images of the current release |

What the run does **not** show: the image of the release before the current one stays on the guest after a plain
`uninstall` then `--purge` (the receipt that named it went with the uninstall); the proof lists them. A small leak,
not fixed. `lab-mini` (2 GiB) was not run. **arm64 was not attempted**: this machine has no
`qemu-system-aarch64` and no AArch64 UEFI firmware, so there is nothing honest to run. A real Traefik accepted the
generated file-provider config (shown by the routes answering).

### 10c. Results against the REAL release v2026.11.1 (lab, 2026-11-17)

First proof with nothing faked except two local copies of release metadata (below). Command:
`lab/install-proof/run-lab-release.sh v2026.11.1 lab-mid` (host: `gh release download`, `sha256sum -c`, `gh attestation
verify` on the archive, `checksums.txt` and `release-manifest.json`; guest: Docker from apt, the release's own
`linux/amd64` binary copied in, then `proof-release.sh`). `lab-mid`, Ubuntu 24.04.5, only `docker.io` 29.1.3 and compose
2.40.3; no docker login (every pull anonymous, `~/.docker/config.json` absent); no `gh` in the guest; no registry mirror,
no `fake-release.sh`. **Two full passes on reset guests, both `PROOF PASSED (54 checks)`** (pass 1: 180 s total, pass 2:
159 s total, each including 29-43 s to install Docker and about 90 s for the proof). Before the scripted passes I ran the
same steps by hand on a first guest, which is how defects 1 and 2 were found.

**Release metadata used, said exactly.** Binary, images and manifest content are the real ones; `bothy install`/`update`
were pointed at two **local** files with `--manifest ~/proof/rel/release-manifest.json --checksums ~/proof/rel/checksums.txt`
because the real pair cannot be installed from (defects 1 and 2). Local `checksums.txt` = the real one plus the line
`b4eeac066a7c...  release-manifest.json`; local manifest = the real one with only `third_party[*].tag` and `.pinned_in`
removed (`jq '.third_party |= map_values({ref})'`), digests untouched. The unmodified real manifest's sha256 is
`4fd7e8e0...db6d`; it is not the one that was installed from.

| Check | Observed |
|---|---|
| asset integrity (host) | all 6 archives `sha256sum -c` OK; `gh attestation verify` (SLSA provenance, signer `.github/workflows/release.yml`) OK for the `linux_amd64` archive, `checksums.txt` and `release-manifest.json`. The extracted `bothy` binary alone is **not** attested (404): only archives and the two metadata files are |
| `gh` in the guest | not installed by default. Installed by hand afterwards: apt's `gh 2.45.0` has **no `attestation` command**; upstream `gh 2.104.0` exists but unauthenticated exits 4 ("run gh auth login"). So the host's attested check does not transfer to a stock guest (defect 3) |
| `bothy version` | `bothy 2026.11.1 (commit fc7b73323870, speaks api 1)`; manifest commit `fc7b73323870767984c32ac30059cd8d141c2fde` |
| default source, no flags | `bothy: checksums.txt has no line for release-manifest.json` (defect 1), rc 1 |
| real manifest as is | `bothy: release manifest: json: unknown field "tag"` (defect 2) |
| `install --dry-run --bind 0.0.0.0` | rc 0, 9 `do` lines, "960 MiB needed", no directory created |
| `install --bind 0.0.0.0` | **29.3 s** (manual), **43.1 s** and **40.9 s** (scripted passes). Pulls: web 4.4-6.7 s, files 4.3-7.6 s, Traefik 6.2-17.4 s; `compose up --wait` 13.6-16.4 s. Unpacked: web 94.8 MB, files 117 MB, Traefik 251 MB (449.7 MB in total). Compressed pull from the registries (skopeo): web 26.6 + files 30.0 + Traefik 55.3 = **about 112 MB** (amd64) |
| bytes through the edge | `GET /` on :80 sha-equals `index.html` read **from the image by digest** (`docker create` + `docker cp`, not from the running container), 5299 bytes; `/version.json` `{"revision":"fc7b73323870767984c32ac30059cd8d141c2fde"}` = manifest commit; the three images present at exactly the manifest digests; the web container's `Config.Image` is the digest ref |
| memory | Traefik 15 MiB / 128, bothy-web 3.4 / 64, bothy-files 19.6 / 256; guest `used` 452 to 574 MiB with the OS |
| files | one root `notes`, `readOnly: true`; `/read` returns the file's bytes; `.env` labelled sensitive; `POST /write` answered 405 by the catch-all and created nothing; notes mount read-only in the container; `/raw` not on :80. As in 10b, now on the real `bothy-files` image |
| edge | no `docker.sock` on Traefik (one `:ro` bind: the dynamic dir); no container privileged, host-networked or mounting the socket; file provider only, `--api=true`, no dashboard; docker publishes only `0.0.0.0:80->80`; `ss` shows 22, 80 and loopback only, nothing on 8100/8899/8099/8080/5000; `traefik:8899` unreachable from another container; no error lines in Traefik's log; **Traefik 3.7.19** |
| re-run | **0.6-0.7 s**, "nothing to do", key unchanged |
| `update --check` / `update`, same release | "up to date: this box already matches release 2026.11.1", 0.5-0.6 s; `.env`, receipt, container id unchanged, no `previous/` |
| update with a manifest for 2026.11.0 (local, own checksum line) | refused: "the manifest is for version 2026.11.0 but this binary is 2026.11.1", nothing changed |
| update with a manifest altered by one byte | refused: "does not match checksums.txt", nothing changed |
| downgrade refusal | **not checkable** with one real release: the binary/manifest version check fires first; a real downgrade needs an older real binary |
| forced failure 1: a web digest `ghcr.io` does not have | pull fails in 0.76 s ("failed to resolve reference"), rolled back, **2.0-2.4 s** in all; `/version.json`, served bytes, `.env` (byte for byte), receipt (`complete` + `last_update_error`) and 3 running containers restored |
| forced failure 2: unhealthy container (the real `bothy-files` image in the web slot) | `compose up --wait` fails in 1.8 s ("bothy-bothy-web-1 is unhealthy"; the 25 s timeout was not needed), rolled back, **5.6-7.7 s** in all; same assertions |
| uninstall, reinstall, purge | as 10b on the real images: containers and network gone, secret and notes kept, reinstall reuses both (6.8 s, images already local); a wrong phrase deletes nothing; `delete bothy data` removes root, notes, secrets and **all three pulled images** (0 images left) |
| arm64 (host `skopeo inspect --no-creds`) | all three own indexes list `linux/amd64` and `linux/arm64`; each arm64 manifest resolves with config `architecture: arm64` and layers (web 27.0, files 30.4, ops 20.2 MB compressed); Traefik's pinned index has an arm64 manifest (50.0 MB). **Pullable, never run**: this box has no `qemu-system-aarch64` and no AArch64 firmware (`/usr/share/AAVMF` absent), so no arm64 guest was booted |

**What failed (honest list)**
1. **`checksums.txt` has no `release-manifest.json` line** (known, being fixed in the release workflow): a stock
   `bothy install` on a real release stops at "checksums.txt has no line for release-manifest.json".
2. **The binary's manifest parser refuses the real manifest.** The release publishes `third_party[*].tag` and
   `.pinned_in`; `ParseManifest` uses `DisallowUnknownFields` and `ImageEntry` has only `ref` and `platforms`, so
   `unknown field "tag"`. Release workflow and CLI disagree about the schema; fix one (accepting `tag`/`pinned_in`
   as informational is the smaller change). Worked around for the proof by the local manifest above. Not fixed here.
3. **Attestation is fatal and unreachable on a stock machine.** With an https source and `gh` on `PATH`,
   `checkAttestation` runs `gh attestation verify` and treats any non-zero exit as "rejected". Measured on the guest
   with apt's `gh 2.45.0` ("unknown command attestation") and with upstream `gh 2.104.0` unauthenticated (exit 4,
   "gh auth login"): both end `bothy: attestation: ... rejected checksums.txt`, rc 1 (a local https server with a trusted
   self-signed cert stood in for the release URL, `--dry-run`, so no images were touched). There is no flag to skip it and
   the message does not say "gh is too old / not logged in". It should tell "gh cannot verify" (skip, say so, print the
   command) from "gh verified and said no". So the **happy https+attested path of Q2 is still unproven end to end**;
   only its two failure modes are measured.
4. Cosmetic: a same-version forced-failure update prints "update to 2026.11.1 failed ... rolled back to 2026.11.1".
5. Cosmetic/operational: `compose up --wait` dominates install time (13-16 s), and a failed update prints the compose
   log twice.

**Moved from unverified to proven by this run:** real GHCR images pulled **anonymously** by digest, multi-arch indexes,
on a clean guest; the real release binary reports its version and commit; install, bytes through the edge, re-run,
same-version update, two refusals, two forced rollbacks, uninstall and purge, no `docker.sock`, only `:80`, all against
real artifacts and a real Traefik 3.7.19. **Still unverified:** the unmodified default path (defects 1-3 block it), a
*verified* attestation inside `bothy install`, a real downgrade, a real A to B update between two real releases, arm64
execution, `lab-mini`, WSL, rootless Docker.

### 10d. Fixes for the two product bugs the real release found (2026-11-17)

Found by the real-release proof (branch `Claude-Bot/Test/real-release-lab-proof`, its 10c): defect 2 (manifest
parser) and defect 3 (attestation fatal on a stock machine). Defect 1 (`checksums.txt` without a
`release-manifest.json` line) is a release-workflow fix, not touched here.

**Manifest schema.** The generator (`scripts/gen-release-manifest.py`) writes `third_party[*].{ref, tag, pinned_in}`;
the parser knew only `ref`. Fix: the parser, not the release, because `tag` and `pinned_in` are useful to a human
and the generator is already shipped in v2026.11.1. `third_party` is now its own type (`ThirdParty`), with `tag`
(string or null) and `pinned_in` (list of strings) typed and validated but never acted on. Strictness is unchanged
where it protects: own images (`ImageEntry`), the top level, and every third-party entry still refuse unknown
fields; every ref must still be a digest reference; schema, version and commit are still checked. A future
top-level field now reads: `the manifest has a field "x" (at its top level) that this bothy does not know: this
binary is older than the release that wrote it ...`. Contract tests (`manifest_contract_test.go`): the real
v2026.11.1 manifest (checked in as `testdata/release-manifest.v2026.11.1.json`, sha256 `4fd7e8e0...db6d`, byte for
byte the published asset) must parse, and the generator itself is **run** against this checkout's compose files
and its output must parse (skipped only without `python3`), so drift on either side fails CI.

**Attestation.** `gh` uses exit 1 both for "verified and refused" and for plumbing errors, and documents only 4
(authentication required), so the exit code alone cannot separate them; `classifyGh` reads the output as well.
Measured with gh 2.96: unauthenticated exit 4; bad token `HTTP 401`; a wrong `--signer-workflow` `Error: verifying
with issuer "sigstore.dev"` (exit 1); a checksums.txt of another repo `no attestations found` (exit 1); an unattested
file `HTTP 404` (exit 1); unreachable network `error creating Sigstore verifier` (exit 1). gh 2.45 (apt): `unknown
command "attestation"`.

| Outcome | Cases | Behaviour |
|---|---|---|
| verified | exit 0 | prints `verified by gh` |
| cannot verify | no `gh`; local source; exit 4 / "gh auth login"; "unknown command"/"unknown flag" (gh older than 2.49); `gh` cannot be run; HTTP 401/403/5xx; Sigstore verifier/network errors; any exit-1 output not matching a verdict form below | SKIPPED, one line with the reason and the exact `gh attestation verify checksums.txt --repo ...` command, "the sha256 checks still ran" |
| verdict: not attested | `no attestations found`; `verifying with issuer`; `failed to verify`; `verification failed`; `HTTP 404` from the attestations API | refused |

Honest limits: this is a heuristic on gh's text for exit 1 (gh has no machine-readable verdict code). An
unrecognised exit-1 message is a skip, never a refusal, and the sha256 line in `checksums.txt` plus the
version-pinned HTTPS source remain the anchor either way; nothing here relaxes them. A 404 is treated as a verdict
because for a public repository and a working login it means no attestation exists for the digest (what a tampered
checksums.txt looks like); a private repository would see a false refusal. `--require-attestation` (install and
update) turns every skip into a failure for anyone who wants the attestation to be mandatory. Tested with a fake
table of every case, and with fake `gh` shell scripts on `PATH` through the real `SysHost` (gh 2.45-style, gh
unauthenticated, gh refusing, gh verifying).

**Cosmetic.** A same-version update that fails now says `re-applying release X failed at <step>; the running release
X was restored` instead of `update to X failed ... rolled back to X`; the compose log is printed once (in the
`update FAILED at` block) instead of three times: the per-step line and the final error no longer repeat it.

**Still unproven:** a verified `gh attestation verify` *inside* `bothy install` against the real release with an
authenticated `gh` (the host check of 10c verified the files, not the binary's call); the exact text of every gh
verdict message across gh versions; the next real release carrying a manifest line in `checksums.txt`.
### 10e. Stock install of a real release: v2026.11.2 (lab, 2026-11-17)

First release cut with the fixed pipeline. The proof ran the **unmodified default path**: the driver's `--stock` mode
(`lab/install-proof/run-lab-release.sh --stock v2026.11.2 lab-mid`) copies into the guest only the released
`linux/amd64` binary and the proof script; the guest runs plain `bothy install` / `update` / `uninstall` with **no
`--manifest`, no `--checksums`, no edited file, no fake release server, no registry mirror**, a guest with only
`docker.io` 29.1.3 + compose 2.40.3, no `gh`, no docker login. The binary finds the release itself:
`installBase = https://github.com/YehudaBriskman/Bothy/releases/download` (`cli/internal/cli/install_cmd.go`) plus
`/v<its own version>/release-manifest.json` and `/checksums.txt`. The pinned version is the binary's own, so the stock
path needs no override (the repository is public; an anonymous `curl` of the asset answers 200). The real manifest sits in
the guest only so the proof can read the expected digests; it is never passed to bothy. Host checks before the guest
ran: `sha256sum -c` OK, `gh attestation verify` OK for the archive, `checksums.txt`, `release-manifest.json`; the
binary that ran in the guest is the one extracted from that attested archive. `bothy 2026.11.2 (commit 930bf6287928)`.

What still uses a local file even in `--stock`: only the proof's negative tests (version mismatch, one-byte tamper,
the two forced failures) pass a derived manifest, because there is no other way to inject a failure. Labelled as such.

| Check | Observed | Status |
|---|---|---|
| defect 1 (checksums line) | `checksums.txt` of v2026.11.2 has the `release-manifest.json` line: "manifest: release-manifest.json sha256 a22e8954f962 matches checksums.txt" | proven fixed |
| defect 2 (`tag`/`pinned_in`) | the real manifest parses in the released binary | proven fixed |
| `bothy install --dry-run`, no flags | rc 0, plan printed, nothing created | proven |
| attestation, guest **without gh** | `attestation: SKIPPED. gh is not installed. The sha256 checks still ran.` plus the exact `gh attestation verify checksums.txt --repo YehudaBriskman/Bothy` command; install continues | proven (skip, not fail) |
| `--require-attestation`, guest without gh | rc 1, `bothy: attestation: gh is not installed, and --require-attestation is set. Verify it yourself with: ...`; nothing created | proven |
| attestation, **authenticated gh** | verified on the HOST only: the same released binary, `install --dry-run` with a temp HOME, the host's gh 2.96 config, and a `docker` shim that refuses (no docker touched, nothing created): `attestation: verified by gh (checksums.txt is attested by YehudaBriskman/Bothy)`. **Not proven in a guest**: that needs a logged-in gh there, and no token was copied into a VM | proven on host / **unproven in guest** |
| `install` (stock) | 38.7 s, 24.3 s (pass 1, pass 2); pulls web 4.4-10.9 s, files 4.4 s, Traefik 5.7-6.5 s, `compose up --wait` ~16 s | proven |
| bytes through the edge | `/` sha-equals `index.html` read from the image by digest; `/version.json` = `930bf6287928...` the manifest commit; three images at the manifest digests; containers created from digest refs | proven |
| re-run | 0.9 s, "nothing to do", key kept | proven |
| `update --check`, and `update`, same release (stock, https) | "up to date: this box already matches release 2026.11.2", nothing changed. `--check` prints the preflight and a `skip`-marked plan; the release shown is "release for binary 2026.11.2": **this binary has no latest-release discovery**, it can only compare against its own release, so "is there a newer release?" is not answerable by it | proven; discovery absent by design |
| version-mismatch, tamper, 2 forced failures (derived local manifests) | refused or rolled back, state restored byte for byte (1.9-2.1 s and 5.5-6.0 s) | proven |
| uninstall / reinstall / purge | as in 10c, images all removed | proven |
| Result | `PROOF PASSED (56 checks)` on both reset guests (54 of 10c plus 2 stock checks); total 164 s and 213 s (Docker install 35 s and 98 s, proof 85 s and 72 s) | proven |

**Unproven**: a verified attestation inside a guest (needs an authenticated gh there); a real downgrade or a real
A to B update between two real releases; arm64 execution; `lab-mini`; WSL; rootless Docker.
Also fixed here: a stray merge-conflict marker line that sat in this file after section 10d.


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
| I19 | The mini stack is **edge (Traefik), the web portal and `files`**; `login` and `network` still need decisions | the smallest thing that proves the whole path plus the first module added from data |
| I20 | Installed edge is **file-provider only**: stackgen renders `traefik.*` compose labels into `routes.yml` at generate time, lints it (no `Host*`, exact `Path()` at priority >= 2 plus one `PathPrefix(/)` catch-all at priority 1, no `api@internal`, no dashboard, entrypoints published or `127.0.0.1`), and refuses `docker.sock`, `privileged`, host network or pid anywhere in the stack | the edge is the most exposed process; a module still declares its route once, in its labels |
| I21 | `files` roots policy for a machine with no `~/stacks` and no notes repo: **one root, `notes`, read-only**, mapped to `<root>/stack/bothy-files/notes` (a symlink repoints it); deny and sensitive lists copied verbatim from `apps/bothy-files/policy.toml` (a test fails on drift); only the 12 read routes are exposed (no write, delete, config, raw or archive); audit and undo dirs are tmpfs | least privilege: read-only three times over (policy, `:ro` mount, no route); a first install has no login in front of files, so the safe default is a viewer. **Anyone who can reach the port can read that folder, which is why the bind defaults to loopback and the `--bind` help text says so** |
| I22 | `bothy update` rolls back to the **previous receipt's digests**, not whatever is running | the receipt is the record of what was verified |

## 12. Open questions, answered (owner delegated the choice, 2026-11-17)

Each answer says what it buys for later change.

- **Q1: file-provider edge, no Docker socket in the edge, before this ships to anyone else.** The edge is the most
  exposed process and the docker socket is root on the box. Installed mode generates a file-provider config from
  the same labels, so a module still declares its route in one place (its compose labels) and the generator turns
  that into edge config; adding a module needs no edge code. The existing live stack keeps its provider until
  its own migration. **Done and proven in the lab (I20, 10b).**
- **Q2: v1 verifies by HTTPS to the release of the same version, the hash line in `checksums.txt`, and
  `gh attestation verify` when a *working* `gh` is present. If `gh` cannot verify (absent, too old, not logged in,
  a network error, a local source) the check is skipped with a one-line reason and the exact command; only a
  verdict from `gh` that the file is not attested is fatal (see 10d). `--require-attestation` makes a skip fatal.**
  No vendored Sigstore in v1: it is a large dependency for a check that `gh` already does. A manifest hash cannot
  be stamped into the binary at build time (the binary is built before the images and the manifest exist), so the
  optional ldflags pin is for distributors who rebuild, not the default. The verifier sits behind one interface,
  so a built-in one can replace the `gh` call later without touching install.
- **Q3: yes. The first release of `bothy install` is the edge plus the portal that answers; every other module is
  added through `stack/modes.yml` alone.** `files` is the first test of that claim, and it must pass without a Go
  edit before the claim is believed. **Result: it held with qualifications, see 13.** `files` is in.
- **Q4: a user-run `bothy update` first.** It is the same code the web updater calls, so Settings > Updates can
  apply on a binary install once it reaches the host through the existing spool design (a later slice). A timer
  that updates unattended is opt-in and arrives after rollback is proven, never the default. **`bothy update` is
  built and its rollback is proven in the lab (section 8, 10b).**

## 13. Prototype versus proven, and next steps

**Proven in the lab (two passes, 53 checks, the second on a reset guest):** the section 10 lifecycle; the
socketless file-provider edge on a real Traefik; the `files` module through the edge, read-only; `bothy update`
A to B with bytes; downgrade refused; `--check` changes nothing; **forced rollback for two different failures**
(absent digest, container never healthy), each restoring the previous version, bytes, `.env` and receipt;
uninstall keeps data; purge needs the typed phrase; no `docker.sock` on Traefik; only `:80` published.

**The "no Go edit" claim for `files`: it mostly held; these are the places it did not**
1. The edge generator was new Go (`stackgen/edge.go`, `override.go`). That was the stated goal and is machinery
   every later module reuses; it is not a per-module edit.
2. `files` forced **one genuine Go fix**: `volumes_remove` split volume specs on the wrong side, and a source
   containing `:` (`${NOTES_ROOT:-${HOME}/claude-notes}:/repos/notes:rw`) was mis-parsed. `volTarget` now reads the
   target from the right (about 14 lines, with a test). Found only by adding a real service.
3. A **workaround instead of an edit:** the override vocabulary has no `env_set`, so the policy path is set by a
   `command_add` wrapping the start in `sh -c "POLICY_FILE=... exec python3 -u app.py"`. A real `env_set` is a few
   lines of Go; it was not added so the claim is not quietly bent.
4. `verify` cannot check `files` by bytes through the edge (its `exec cat file` comparison cannot match JSON), and
   a `contains` kind needs Go. `files` is therefore proven by `proof.sh`, not by the installer's own verify.
5. A relative file mount (`./policy.toml`) would be created as a directory by the generator, so the policy is
   mounted as a directory (`./policy`).

**Prototype only:** user scope only; `--mode` accepts only `mini`; `bothy update` installs the release of the binary
it is (no discovery of a newer release, no binary download); the web updater does not use it yet; amd64 only;
`checkAttestation` ran in the VM only in its skipped branch (the verified and rejected branches are unit-tested
with a fake `gh`).

**Not verified at all** (real GHCR images and release assets moved to proven in 10c; a verified `gh attestation verify`
inside `bothy install` did not, see 10c defect 3): **arm64 execution** (the manifests are pullable, no
qemu-system-aarch64 here); a WSL host; `lab-mini`; a host where port 80 is taken by another container; rootless
Docker (refused, untested); Docker `iptables`/`nft` coexistence; the live box (must not be, per the go/no-go);
the write, delete and raw/archive routes of `files` (deliberately not exposed).

**Exact next steps**
0. **Found by the real release (10c):** the manifest and the CLI disagree about the schema (`tag`, `pinned_in`), and
   `checkAttestation` must skip, not fail, when `gh` is too old or unauthenticated. Without those and step 1 below,
   `bothy install` cannot complete from a real release with no flags.
1. D34 side: the release must publish `release-manifest.json` and `checksums.txt` as assets of the same tag,
   `checksums.txt` must contain a `release-manifest.json` line (**v2026.11.1 did not: the `cli` job wrote
   `checksums.txt` before the manifest existed, and its own `bothy install` refused it. `release.yml`'s
   `release-manifest` job now appends the line, re-uploads and attests; unproven until v2026.11.2 or later**,
   see `distribution-and-packaging.md` 8.1), `bothy-web` and `bothy-files` must be built with
   `REVISION=<commit>`, and `images`/`third_party` keys must be the image's last path segment. Then stamp
   `PinnedManifestSHA` in the release build.
2. Re-run `REPAIR_CHECKSUMS=0 lab/install-proof/run-lab-release.sh <tag>` on the next release (the default https path, no
   local copies), and a verified attestation with an authenticated `gh` in the guest. Done once with workarounds (10c).
3. Add `env_set` and a `contains` verify kind (small Go) so the next module really is data-only.
4. Run the proof on `lab-mini` and an arm64 guest (needs qemu-system-aarch64 and firmware on the host).
5. Wire the web updater to read the receipt's manifest and call the same update code; add the system scope.
6. Wire `bothy.sh` to download the binary (checksum-verified) instead of cloning.

## 14. Files

`stack/modes.yml`; `cli/cmd/stackgen`; `cli/internal/stackgen`; `cli/internal/install/{embed,manifest,preflight,
install,uninstall,host}.go` and `stack/` (generated); `cli/internal/cli/install_cmd.go`;
`cli/internal/install/{attest,update}.go`; `cli/internal/stackgen/{edge,override}.go`;
`stack/installed/bothy-files.policy.toml`; `lab/install-proof/{run-lab,fake-release,proof}.sh` (faked release) and `lab/install-proof/{run-lab-release,proof-release}.sh` (real release, takes the tag).
