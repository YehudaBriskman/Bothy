# Distribution and packaging: installing Bothy "like Chromium or VS Code"

_Written 2026-11-16. Design only; nothing here is built. Status: **Proposed, needs owner** (decisions D29 to D39,
section 8). Triggered by the owner's requirement: "how will we be able to run the stuff as packages, like how we
install chromium or vscode on linux, windows and almost everything." That challenges D27 ("platform packages, not
in v1") in `cli-and-control-plane.md` and is answered here properly, even though building is later._

Evidence labels used below: **VERIFIED** = fetched or measured in this session (date 2026-11-16); **MEMORY** = I
believe it from prior knowledge and did **not** re-check it today, so check before relying on it; **ASSUMPTION** =
an inference or a guess. A claim with none of these is a design statement, not a fact about the world.

## 0. The answer in fourteen lines

1. **Bothy is four things with four lifecycles**, not one binary (section 1). A native package should contain
   only the two that run *on the host* and need root-adjacent integration: the **client** (`bothy`) and the **host
   layer** (`bothy-hostd` plus its systemd units). The **stack** (charts, compose, module catalog) and the
   **images** are pulled at runtime from a signed release and are never inside a package.
2. **Ownership rule for versions (D29).** The OS package manager owns the host layer (client, hostd, units); the
   Bothy updater owns the stack (charts, images, modules) and only it applies stack changes. `apt upgrade` can
   therefore never change a running stack, and the updater refuses a stack release whose declared host-layer range
   does not include what is installed (section 1.3).
3. **Two packages, not one (D30):** `bothy` (the client; **no maintainer scripts at all**) and `bothy-host` (hostd,
   units, the `bothy` system user; has scripts; depends on `bothy` of the same version). There is **no
   `bothy-stack` package**.
4. **D27 should change, in stages (D31):** v1 slice 1 stays as D27 says (tarball + pinned installer + `mise`). The
   *next* step is a `.deb`/`.rpm`/`.apk` **attached to the GitHub Release** (no repository, no new key, verified by
   attestation). The **apt/dnf repository** comes only after the key ceremony in section 4.4 is done.
5. **Hosting (D32):** a static repository generated in CI and published on GitHub Pages from a **separate repo**,
   behind a name the owner controls; Cloudsmith is the named fallback.
6. **Key custody (D33):** an offline OpenPGP primary key with a signing subkey on a hardware token; the
   `Release`/`repomd.xml` files are signed **on the maintainer's machine**, never by CI. CI can then build packages
   but cannot make apt accept a package the maintainer did not sign.
7. **One pipeline, one config:** `nfpm` turns one YAML into deb, rpm, apk, Arch and MSIX packages (VERIFIED, section 3);
   GitHub attestations and an SBOM cover everything else.
8. **Rejected:** Flatpak, Snap, AppImage, an OCI image as *the* installer, Chocolatey, MSIX, `fpm`. **Deferred:**
   AUR, Nix, Alpine repo, Homebrew tap, winget/Scoop, macOS notarised `.pkg`. Reasons in section 2 and the matrix.
9. **A small proof was run** (section 5.3): an nfpm-built deb installed, upgraded, downgraded, removed and purged
   on the Ubuntu 24.04 lab guest, started nothing, kept a conffile, and kept data across purge.
10. **Windows and macOS are client-only** for the foreseeable future (section 6): `bothy.exe` and a macOS
    binary manage a remote or WSL2 box over the same API and MCP. Nothing in v1 may block that.
11. **What undermines a decided item:** nothing in D1 to D14. D27 and D22 (both *Proposed*) are amended; D17
    (hostd stays Python) gains a `python3` dependency on the host package (section 8).
12. **The one-line summary of the packaging strategy:** *the package installs the thing that can be trusted to be
    old; the release delivers the thing that must be new.*
13. **Biggest open risk:** a long-lived signing key is a second root of trust (R26). Mitigation is the offline
    key and an honest "revocation is a key rotation plus a keyring package" runbook (section 4.5).
14. **Cost to keep this possible now: about one day** of naming, path and artifact-layout discipline (section 5.1).

## 1. What is being distributed

### 1.1 The artifacts

| Artifact | What it is | Today | Lifecycle owner | May a native package contain it? |
|---|---|---|---|---|
| **A1 client** | `bothy`: static binary, thin client, `mcp` stdio server (D15, D18) | a 377-line bash script (`scripts/bothy`) plus the `scripts/bothy.sh` installer | the user's package manager or `bothy self update` | **Yes** (`bothy`) |
| **A2 host layer** | `bothy-hostd` (Python, about 8,800 lines, D17), its systemd units, the spool dir, the `bothy` system user | `~/.local/lib/bothy-updater/current` via `just install-updater`, a **user-level** unit | the package manager when installed from a package; `bothy self update` otherwise | **Yes** (`bothy-host`) |
| **A3 stack definitions** | compose files, Helm charts, `updates.toml`, `catalog.toml`, module declarations | files in the git checkout | the **Bothy updater**, from a release | **No**: pulled at runtime |
| **A4 container images** | `bothy-web`, `bothy-files`, `bothy-ops` (and third-party modules by pinned tag or digest) | **built on the box from the checkout** (`docs/guide/upgrading.md`: `bothy-web:<sha>` built before anything changes) | the Bothy updater | **No**: pulled by digest |
| **A5 web app** | the portal front end, the files app | inside A4 | A4 | No (inside images) |
| **A6 data and keys** | settings DB, spool, master key (KEK), backups | `$STATE_ROOT`, a host file | the **user**, never a package | **Never** (a package may create the empty directory, nothing else) |

Two facts in that table deserve to be loud. **(1)** Images are built from the checkout today; a package-installed
host has *no checkout*, so a package cannot deliver Bothy without a **new capability**: publishing the images to a
registry and pulling them by digest (D34). That is the single largest hidden cost of "install it like a package", and
it is independent of which package format is chosen. **(2)** The updater's own-code path (`owncode.py`) deploys the
newest green `v*` tag from `origin/main`; with no checkout that path becomes "fetch the signed release manifest and
the digests it names" (the shape `updates-and-rollback.md` already assumes for the cluster Job updater).

### 1.2 The three ways to split ownership, and how each fails

| | **A. Package owns everything** (stack under `/usr/share/bothy`, image digests in the deb) | **B. Package owns client + host layer; stack pulled from a signed release** (recommended) | **C. Package is only a bootstrap `bothy`; hostd also pulled at runtime** |
|---|---|---|---|
| Who upgrades what | `apt upgrade` upgrades the stack | apt upgrades A1 and A2; the updater upgrades A3 to A5 | `bothy` upgrades everything |
| Failure: unattended or casual `apt upgrade` | **changes a running stack at 03:00**, bypassing the class gates, the maintenance window, `max_auto_per_night`, "any major is manual" and the rollback timer (`updates.toml`). A Postgres major could ride in on a routine upgrade | cannot touch the stack; the worst it does is replace the client and hostd, both of which are **compatible-range checked** | n/a |
| Failure: rollback | `apt install bothy=<old>` rolls the files back but not the volumes or the DB schema; two rollback systems disagree | one rollback path for the stack (the updater's), one for the host layer (dpkg) | one path |
| Failure: "deploy only what was reviewed" (a decided rule) | the deb is built from `main` by CI; review is the same, but the *apply* decision moves from the gated updater to dpkg | preserved: apply is still the gated, planned, `planId`-checked path | preserved |
| Failure: supply chain | the package signature covers images only by embedding digests, so every stack change is a new signed package: a heavy cadence for a one-person project | the root-run code (A2) arrives through the distro-grade signature channel; the stack through the release signature + digests | **root-run code is fetched from the network at runtime**: strictly worse than a signed package for A2, and `bothy-hostd` is the one component that holds the Docker socket |
| Failure: air gap | works (everything in the package, but the package is multi-hundred MiB) | needs the images from somewhere (`bothy bundle`, out of v1) | needs the network |
| Fit with D17 and `security-model.md` 6.1 | breaks them: hostd's closed request schema assumes the catalog is reviewed *by the updater* | fits | fits, with the supply-chain regression |
| Cost to the maintainer | every stack change is a package build, sign, publish | one slow-moving package, one fast-moving release | least |

**Resolution (D29).** B. The package manager owns the **host layer**: it changes rarely, runs as root-adjacent, and
benefits from the platform's signature and rollback story. The Bothy updater owns the **stack**: it changes often,
is gated by classes and windows, and already has the only rollback this project trusts.

### 1.3 The compatibility contract that makes B safe

* The signed release manifest (`bothy-release.json`, one per tag, attested) carries `host-layer: ">=X,<Y"` and
  `min-client: Z` (the server already advertises `min-client` in a response header, `cli-and-control-plane.md`
  2.5). `bothy update plan` **refuses** a stack release outside the installed host-layer range and prints the exact
  package command (`apt install bothy-host`), never the reverse.
* A package install writes `/usr/lib/bothy/install-method` containing `deb` (or `rpm`, `apk`). **`bothy self update`
  reads it and refuses**, saying `this copy is managed by apt: run apt upgrade bothy`. A tarball install writes
  `tarball`. This stops two updaters fighting over one binary. (The existing script's "refuse rather than choose
  another path" rule, `cli-and-control-plane.md` 2.4, already points this way.)
* **Package upgrade never restarts hostd mid-job.** The postinst does not restart anything. hostd compares its own
  executable's identity at idle and re-executes between jobs; an in-flight job finishes on the old code because dpkg
  replaces files by rename. (Contrast with Tailscale's deb, VERIFIED below, which restarts its daemon on every
  configure.) ASSUMPTION: this idle re-exec is small to build; if it is not, `needrestart` and a documented manual
  restart are the fallback.
* **Unattended upgrades cannot apply it by accident.** Ubuntu's default `Unattended-Upgrade::Allowed-Origins`
  list names the distro and security origins, not a third-party repository (MEMORY). A user who adds the Bothy
  origin to that list has chosen to let the *host layer* auto-update, which is acceptable because of the range
  check above.
* The package **does not depend on Docker or k3s** (`Suggests` at most). `bothy install` installs and pins k3s per
  `install-and-bootstrap.md`; a package that pulled in `docker.io` would change the host's firewall backend
  (the S10 hazard).

## 2. Channel by channel

### 2.1 How the channels you named actually work (VERIFIED where marked)

| Vendor | What the repository really looks like | What the package does at install | What went wrong historically |
|---|---|---|---|
| **Docker** | `download.docker.com/linux/ubuntu/dists/noble/Release`: `Origin: Docker`, five architectures (amd64 arm64 armhf s390x ppc64el), components `stable edge test nightly` (VERIFIED) | does not add the repo; the docs tell you to add a keyring and a source by hand (MEMORY) | the firewall backend and `docker` group (root-equivalent) side effects are exactly why section 1.3 forbids depending on it |
| **VS Code** | `packages.microsoft.com/repos/code`: `Release` says `Description: Generated by aptly`, `Origin: code stable`, archs amd64 arm64 armhf (VERIFIED). So Microsoft runs **aptly** for this | the `.deb` postinst installs a repo definition and a keyring so the package updates itself (MEMORY, behaviour documented by VS Code; not re-checked) | the "Conflicting values set for option Signed-By" breakage when a user's manual `signed-by` entry and the package-added one disagreed (MEMORY) |
| **Chrome** | `dl.google.com/linux/chrome/deb`: `Origin: Google LLC`, archs amd64 arm64 only (VERIFIED); MD5Sum-style hashes still listed | adds `google-chrome.list` unless opted out via `/etc/default/google-chrome` (MEMORY) | signing-key rotations that broke `apt update` until users re-fetched the key (MEMORY) |
| **GitHub CLI** | `cli.github.com/packages`: `Origin: gh`, archs i386 amd64 armhf arm64 (VERIFIED), a single `stable` suite | none; manual keyring + source per the docs (MEMORY) | n/a |
| **Tailscale** | `pkgs.tailscale.com/stable/ubuntu`: one `Release` per codename; `noble.tailscale-keyring.list` is `deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main`; the repo key is a 4096-bit RSA key created 2020-02-25; the package `Recommends: tailscale-archive-keyring (>= 1.35.181)` (VERIFIED) | **restarts `tailscaled` on every configure**; `purge` runs `rm -rf /var/lib/tailscale` (VERIFIED from the `.deb`'s own postinst and postrm, version 1.38.4) | n/a |

Debian's own third-party guidance (VERIFIED, `wiki.debian.org/DebianRepository/UseThirdParty`): sign with
OpenPGP; export the key in binary form; put it in `/usr/share/keyrings` if a *package* manages it, else
`/etc/apt/keyrings`; **never** in `trusted.gpg.d` or via `apt-key add` (that trusts the key for every repository);
`signed-by` must name a **file, not a fingerprint**; pin third-party origins to priority 100 or 1, never higher;
ship the key as a repository-specific keyring package. The page does **not** bless packages that add repositories
behind your back and warns that maintainer scripts run as root. **Bothy's package will therefore not add its own
repository** (the VS Code and Chrome behaviour): adding the repo is a documented, user-run step, and the keyring
is a separate small package `bothy-archive-keyring`, as Tailscale does.

What the two Tailscale facts teach, concretely: Tailscale is a network daemon, so restart-on-upgrade is defensible
for it. Bothy supervises other software and holds a database, so the contract is the reverse: **install and
upgrade start nothing, restart nothing, enable nothing; purge deletes no user data.**

### 2.2 The channel table

Columns: what it gives the user; maintainer cost; confinement; update behaviour; verdict. Phase and package
contents are in the matrix (section 5.2).

| Channel | Gives the user | Maintainer cost | Confinement consequence | Update behaviour | Verdict |
|---|---|---|---|---|---|
| **A. `.deb` + hosted apt repo** | `apt install bothy bothy-host`; Debian, Ubuntu, Mint, Pop, WSL Ubuntu; systemd units integrated; `apt upgrade` | a static repo (hosting), an OpenPGP key (custody), a `Release` signing step per release, maintainer scripts to audit, test matrix on 3 guests | none (native, root) | `apt upgrade` for the host layer only (D29) | **KEEP, staged** (asset first, repo second) |
| **B. `.rpm` + yum/dnf repo** | Fedora, RHEL-family; same | same as A plus **per-package signing** (dnf verifies each rpm with `gpgcheck`, not only the repo metadata: MEMORY) and `repo_gpgcheck`; `createrepo_c` | none | `dnf upgrade` | **KEEP, same release as A** (nfpm emits it from the same YAML; testing doubles) |
| **C. Arch AUR / pacman** | `yay -S bothy-bin` | a PKGBUILD that downloads the release tarball and pins its sha256; AUR is user-submitted and **unreviewed**; pushes by SSH key; nfpm can also emit an Arch package (VERIFIED banner: "apk, arch linux, deb, ipk, msix, and rpm") | none | AUR helper, user's responsibility | **DEFER**: cheap, but a second place to keep a hash correct; do it when someone asks |
| **D. Alpine `apk`** | `apk add` on Alpine hosts (a natural fit for the **Compose-below-4-GiB** install, D1) | an RSA signing key (`abuild`) and an `APKINDEX` signed with it; official `community` needs an aports MR and a source build (MEMORY) | none (musl; a Go static binary is fine; hostd's Python is in Alpine's repos: ASSUMPTION) | `apk upgrade` | **DEFER**; `.apk` as a release asset is free from nfpm, the repo is not |
| **E. Nix / flakes** | declarative installs, a NixOS **module** that could define the service | a flake in this repo is cheap; nixpkgs inclusion is a PR to a review queue; `buildGoModule` needs a vendor hash maintained per release | none | `nix flake update` | **DEFER**; high value to a small audience, and a NixOS module is a *second* implementation of the host layer |
| **F. Homebrew (macOS and Linux)** | `brew install` of the **client** on a laptop; the macOS story | a **tap** (own repo `homebrew-bothy`, no review, goreleaser can generate the formula or cask: MEMORY); homebrew-core requires a notable project and **building from source** (the Acceptable Formulae page VERIFIED: formulae "must either build from source or install portable, platform-independent output"; the star/fork thresholds are MEMORY, about 75 stars and 30 forks) | none, but Linuxbrew installs under its own prefix and `brew services` makes *user* units: **not a way to install a root host layer** | `brew upgrade` | **KEEP as a tap, client only, after the first package** |
| **G. Flatpak** | a sandboxed desktop app | Flathub needs a **from-source build with no network** (VERIFIED: "built entirely from source code ... Builds have no network access"; exceptions case by case); a review PR per app | A Flatpak app has no view of the host's Docker socket, systemd or `/var/lib` unless granted. The escape hatches (`--filesystem=host`, talking to the `org.freedesktop.Flatpak` bus name to run `flatpak-spawn --host`) exist (MEMORY) but Flathub says static permissions "must be kept to an absolute minimum" (VERIFIED), so a **host-managing** app would not be approved (ASSUMPTION: reviewer discretion) | Flatpak updates the app | **REJECT for the host layer.** A Flatpak of the *client only* could work as a remote client, but there is no desktop UI to deliver; reject |
| **H. Snap** | `snap install` on Ubuntu | a snapcraft build and a store account; strict confinement lacks Docker and systemd access without privileged interfaces that are not auto-connected; **classic** confinement needs a manual store-review grant (MEMORY; Canonical's classic-review page could not be fetched today, it sits behind a login) | a strict snap cannot manage Docker, k3s or systemd; classic can, at the price of a review queue and no sandbox | auto-refresh **on a store schedule the maintainer does not control** (MEMORY): a forced refresh of a control plane is the failure D29 exists to prevent | **REJECT** (a forced auto-update channel for a thing that must update on its own gates) |
| **I. AppImage** | one file, no install | tiny | no integration: no units, no user, no udev, nothing a daemon needs | none (zsync optional) | **REJECT** for the host; for the client it is a worse tarball |
| **J. `mise` / `ubi` / `asdf`-style GitHub-release installs** | `mise use github:...` of the **client** | **zero**, provided asset names follow the `bothy_<version>_<os>_<arch>.tar.gz` convention already in D22's pipeline | none | `mise upgrade` | **KEEP (free)**; verify the naming works in slice 1 (the existing ASSUMPTION in 2.2 stays an assumption) |
| **K. Static tarball + `bothy.sh`** | works everywhere, including macOS and WSL, no root | already planned (D22, section 2.3) | none | `bothy self update` | **KEEP: the baseline every other channel must not be worse than** |
| **L. OCI image `docker run bothy`** | one command, no install | a registry (needed anyway, D34) | to manage the host it needs the Docker socket and host paths mounted in, i.e. the blast radius `SECURITY.md` spends a section on, delivered as a one-liner | image pull | **REJECT as the installer.** *Keep* a tiny client image for CI use only (**DEFER**) |
| **M. Native Windows (winget, Scoop, Chocolatey, MSI, MSIX)** | the **client** | see section 6 | n/a | winget, Scoop | **FUTURE**: winget + Scoop client-only; **REJECT** Chocolatey and MSIX/MSI for v1 |
| **N. macOS `.pkg`** | double-click install | Apple Developer Program fee (VERIFIED: 99 USD per membership year), notarisation, a macOS runner | none | none | **FUTURE**, only if browser-downloaded installs matter; the brew tap and `bothy.sh` need no fee (section 6) |
| **O. Distro-official (Debian `main`, Fedora)** | `apt install bothy` with no repo | a source build with every Go and Python dependency packaged or vendored per distro policy; a sponsor | none | distro cadence | **REJECT**: wrong order of magnitude for a one-person project |
| **P. Launchpad PPA / Fedora COPR / OBS** | hosted repos **with the service holding the signing key** | source packages built on the service; no network during the build, so Go modules and Python wheels must be vendored (MEMORY) | none | as A/B | **NAMED FALLBACK, not v1**: it offloads key custody, which is attractive, at the price of a source-package build and a platform dependency |

### 2.3 The channels that can only be a remote client

Because a confined package (Flatpak, strict Snap) or a foreign OS (Windows, macOS) **cannot reach the box's Docker
socket, systemd or k3s**, the only thing it could ever contain is the **client** talking to a box over the network
API (`cli-and-control-plane.md` 2.10, contexts). Channels G, H, I fall in that group and were rejected anyway
because the client alone does not justify a store and a review queue. Channels F, J, M and N are the legitimate
client-only channels. **The rule for the matrix: only native Linux packages (A, B, C, D) and the tarball may carry
`bothy-host`.**

## 3. Tooling: one pipeline for one maintainer

### 3.1 Tools compared

| Tool | Emits | Language of the product | Verdict |
|---|---|---|---|
| **nfpm 2.49.0** | deb, rpm, apk, Arch, ipk, MSIX from **one YAML**, given already-built files; 0 dependencies, a single static Go binary. **VERIFIED**: tarball checksum matched `checksums.txt`; `nfpm --version` prints "a simple and 0-dependencies apk, arch linux, deb, ipk, msix, and rpm packager"; built a deb, an rpm and an apk from one config (section 5.3). | any (it only packs files) | **USE**, in either language |
| **GoReleaser** | wraps nfpm (`nfpms`) and adds archives, checksums, SBOM via syft, cosign signing, Homebrew, Scoop, winget, AUR, Nix, Snap and Docker/multi-arch pipes (MEMORY: pipe names and which are OSS versus Pro were not re-checked) | **Go** | strong fit if the CLI is Go |
| **cargo-dist** | archives, shell and PowerShell installers, Homebrew, MSI, npm, from `Cargo.toml` metadata (MEMORY) | **Rust** | the equivalent one-tool pipeline if the CLI is Rust |
| `cargo-deb`, `cargo-generate-rpm` | deb / rpm from `Cargo.toml` | Rust | redundant with nfpm; fine alone |
| **fpm** | many formats | any | **reject**: a Ruby toolchain in CI, less reproducible, and a heavier supply-chain surface than a static Go binary for the same job |
| `cross`, `cargo-zigbuild` | Rust cross-compilation | Rust | needed only for Rust; Go cross-compiles with `GOOS`/`GOARCH` and no toolchain |
| **GitHub Actions matrix** | native runners per OS/arch | any | needed for macOS notarisation, Windows signing, and a **native arm64** smoke test (ASSUMPTION: arm64 hosted runners are available to public repos; check) |
| **release-please** | version bump PRs from conventional commits | any | **do not adopt**: `release.yml` and `scripts/release-decision.sh` already tag only when CI, Install and Upgrade are green on one commit; a second release author would fork that gate |
| **syft** (SBOM), **GitHub artifact attestations**, **cosign** | SBOM; build provenance; signatures | any | see 3.3 |

### 3.2 Version scheme (decide it before the first package)

`VERSION` is CalVer (`2026.9.0` in `VERSION`, release `2026.11.0` on `main`). It is valid as a Debian upstream
version and an RPM version. Rules so every format sorts correctly:

* A pre-release uses a tilde: `2026.12.0~rc1` sorts **before** `2026.12.0` in dpkg and in RPM 4.10 or later
  (MEMORY). A hyphen (`-rc1`) does not do that in dpkg and is wrong.
* Debian revision `-1` for packaging-only rebuilds; RPM `Release: 1`. **No epoch** unless a version ever has to go
  backwards, which a reproducible release process should make unnecessary.
* The git tag stays `v2026.11.0`; asset names stay `bothy_<version>_<os>_<arch>.tar.gz`; package file names are
  the distro conventions (`bothy_2026.11.0-1_amd64.deb`). A check (`scripts/checks/version.sh` already exists)
  should also assert the nfpm config version equals `VERSION`.

### 3.3 Signing, provenance and SBOM: D22 revisited honestly, per channel

D22 said: `checksums.txt`, pinned sha in `bothy.sh`, GitHub attestation; no cosign. **That remains right for the
tarball path.** The package channels add a requirement D22 did not consider: **apt, dnf and apk verify their own
signature formats, and none of them understands a GitHub attestation or a Sigstore bundle** (MEMORY: apt verifies
OpenPGP `InRelease`/`Release.gpg` and then the hashes in `Packages`; dnf verifies repo metadata and each rpm
against configured OpenPGP keys; apk verifies RSA-signed index and packages). So:

| Channel | What the client verifies | What we must produce | New secret? |
|---|---|---|---|
| tarball, `bothy.sh`, `mise` | sha256 pinned in the script; optional `gh attestation verify` | `checksums.txt`, attestation, SBOM | no (OIDC, keyless) |
| container images (D34) | digest pin from the signed release manifest; optionally the attestation | `actions/attest-build-provenance` with `push-to-registry` (MEMORY), SBOM | no |
| **apt** | OpenPGP `InRelease` over `Packages`, which holds each `.deb`'s SHA-256 | a signed `InRelease` | **yes, a long-lived OpenPGP key** |
| **dnf / yum** | `repomd.xml.asc` if `repo_gpgcheck=1`, **and** each rpm's own signature if `gpgcheck=1` | signed metadata **and** signed rpms | **yes, same key** |
| apk | signed `APKINDEX` and packages | RSA key | **yes, a second kind of key** (deferred with D) |
| Homebrew tap, Scoop, winget | sha256 in the formula/manifest (the manifest is the trust anchor); winget adds an AV scan and review | the hash, from our release | no |
| Windows `.exe` | Authenticode and SmartScreen | a code-signing certificate | yes (section 6) |

**Cost/value verdict.** Cosign stays *skipped* (D22 unchanged): attestations already say "this archive came from
this workflow at this commit" and no package manager can check cosign anyway. The **OpenPGP archive key is a
genuinely new asset** and the real cost of the package channels; it must be justified by value, not by fashion.
The value: `apt upgrade bothy-host` is the *normal* path for a Debian user and the only one that is verified by
their operating system without extra steps.

### 3.4 One release pipeline (shape, not implementation)

```
release.yml (exists: tag when CI + Install + Upgrade are green on one commit)
  └─ build   : bothy (and hostd bundle) for linux amd64/arm64 [+ darwin, windows client-only]; -trimpath, pinned toolchain
  └─ package : nfpm: bothy, bothy-host, bothy-archive-keyring  ->  .deb .rpm [.apk]
  └─ attest  : checksums.txt, SBOM (syft), build-provenance attestation, for every file
  └─ release : GitHub Release assets (the baseline channel)
  └─ repo    : generate static apt/yum metadata from the assets  (UNSIGNED, uploaded as a CI artifact)
MAINTAINER (manual, ~2 minutes, offline key):  sign InRelease / repomd.xml / rpms  ->  publish to the repo host
```

Reproducibility: two CI builds of one commit must hash equal (Go: `-trimpath`, pinned toolchain; nfpm output is
reproducible when `SOURCE_DATE_EPOCH` is set and file mtimes are normalised, ASSUMPTION: test it, because
timestamps inside ar/tar members are the usual leak). The check is "build twice, compare" (existing plan, 2.2).

### 3.5 Hosting options for the repository (pick ONE for v1: D32)

| Option | Cost (MEMORY unless marked) | Limits and trust | Lock-in | Verdict |
|---|---|---|---|---|
| **GitHub Pages**, separate repo, CI-generated `reprepro`/`aptly`/`createrepo_c` output | free | published site at most **1 GB**, **100 GB/month soft** bandwidth, and "not intended" as a business host; the page points to Releases for large files (all VERIFIED, GitHub Pages limits). apt needs the `.deb` under the repo base URL (`Filename:` is relative), so the pool must live there; keep the last 3 versions × 2 arches, about 15 MB per set (ASSUMPTION), well under 1 GB | **low** if the URL is on a domain the owner controls (a CNAME); high if clients are told `*.github.io` | **RECOMMENDED for v1** |
| Release assets only, no repo | free | no `apt upgrade`; the user re-downloads | none | the **stepping stone** (D31) |
| **Cloudsmith** (free open-source tier) | free for OSS by program; paid otherwise; the terms page returned HTTP 429 today, **not verified** | hosted deb/rpm/apk with their key or yours; bandwidth quotas | medium | **named fallback** when Pages' bandwidth is exceeded |
| packagecloud, Fury (Gemfury) | paid plans from a small monthly fee | hosted | medium | not needed for v1 |
| **Launchpad PPA** | free | **Ubuntu only**; source packages built on Launchpad **without network**; Launchpad holds the signing key (custody offloaded) | high (Ubuntu-only format) | no |
| **OBS** (Open Build Service) / **COPR** | free for open source | builds deb+rpm+Arch from source; the service holds the key; Go and Python deps must be vendored | high | **v2 option** if key custody becomes the blocker |
| aptly / reprepro on a VPS | VPS cost | you run a server and its patching | low | no: more toil than Pages |

Generator: **`reprepro`** for the apt side (a flat config, deterministic, produces `InRelease` unsigned when told
not to sign) and **`createrepo_c`** for the rpm side; both are in distro repositories, both are scriptable in CI.
`aptly` is what Microsoft runs for VS Code (VERIFIED from its `Release` header) but carries a database to keep.
ASSUMPTION: `reprepro` can be run with signing disabled and the signing done as a separate step; confirm in the
spike.

## 4. The security model of packages

### 4.1 What a maintainer script may and may not do (rules for `bothy-host`; `bothy` has none)

| Rule | Why | Proven in the VM test? |
|---|---|---|
| **No network access** in any script | the script runs as root during an unrelated `apt upgrade`; a download there is an unreviewed code path | by construction |
| **Start, enable and restart nothing.** Tell systemd the unit exists (`daemon-reload`), print the next command (`sudo bothy install`) | the owner's rule: no stack start without consent; also Tailscale's restart-on-upgrade (VERIFIED) is the anti-example | yes: after install `is-enabled` = `disabled`, `is-active` = `inactive` |
| **Edit no other software's configuration** (no `daemon.json`, no `iptables`, no `/etc/wsl.conf`, no sshd or Tailscale config) | the S10 firewall-backend incident is the reason | by construction |
| **Create exactly:** a system user and group `bothy` (no login shell, home `/var/lib/bothy`), the directory `/var/lib/bothy` mode `0750`, and nothing else on disk | a package may create the *empty* state directory; it never creates the master key (the first `bothy install` does, mode `0600`, `O_EXCL`) | yes |
| Use `set -e`, POSIX `sh`, idempotent steps (a re-run after a failed install must not fail) | dpkg re-runs scripts on retry | yes |
| `prerm remove`: stop hostd only on `remove`/`deconfigure`, never on `upgrade` | an upgrade must not interrupt a job | yes (script in the proof) |
| **Never `rm -rf` a directory the package does not own** | see 4.3: the proof's own naive `postrm` would have deleted `/etc/bothy`, which is where `settings-store.md` Q1 puts the root-install master key | yes: it deleted `/etc/bothy` on purge, which is exactly the bug to avoid |

Conffiles: every file under `/etc/bothy` that a package ships is a conffile (`type: config|noreplace` in nfpm,
VERIFIED to be accepted) and the **admin's edit survives upgrade and downgrade** (VERIFIED in the VM: an appended
line was still there after v1 to v2 to v1). The master key is **not** a conffile and not in the package at all.

### 4.2 Users, the service unit and the Docker socket

* **Package install:** a dedicated system user `bothy`; `/etc/bothy` (config), `/var/lib/bothy` (state, spool, keys);
  unit `bothy-hostd.service` running as `bothy` with `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`,
  `PrivateTmp=yes`, `StateDirectory=bothy`, `ConfigurationDirectory=bothy` (the stub unit with exactly these passed
  `systemd-analyze verify` with no output on Ubuntu 24.04: VERIFIED). Further hardening
  (`CapabilityBoundingSet=`, `RestrictAddressFamilies=`, `SystemCallFilter=`) is a design item to measure, not a claim.
* **Honest limit:** hostd must drive Docker, and **membership of the `docker` group is root-equivalent**. A
  dedicated user narrows what *else* the process can touch (files, `$HOME`, other users' data); it does **not**
  make hostd unprivileged. The existing defence stays the real one: a closed request schema, fixed argv, `planId`
  re-derivation (`security-model.md` 6.1). The package must say this in its description and in `SECURITY.md`.
* **User install (tarball):** the same binaries, run as the invoking user, state under XDG paths. This is
  today's model (a user-level unit). **Same code, different roots**: section 5.1 makes that a path abstraction,
  not two programs.

### 4.3 The master key, data, removal and purge

| Event | Package install | User install | Rule |
|---|---|---|---|
| Key location | `/etc/bothy/master.key`, root-owned `0600` (`settings-store.md` Q1, unchanged) | `$XDG_CONFIG_HOME/bothy/master.key` `0600` | host file, outside the datastore; **only the host CLI decrypts** (decided) |
| `apt remove bothy-host` | binaries and unit gone; **config, data, key, user stay** | n/a | removal is reversible |
| `apt purge bothy-host` | removes **only dpkg-owned conffiles** (dpkg does that itself); **does not delete `/var/lib/bothy`, the master key, or the `bothy` user** | n/a | Debian practice is to leave system users in place on purge (MEMORY) and Tailscale's `rm -rf /var/lib/tailscale` (VERIFIED) is the anti-example: a purge that destroys a settings DB with its key is unrecoverable |
| Deleting data | the explicit, typed **`bothy uninstall --data`** (a `host-only`, `destructive` verb: confirmation by typing the box name, and refuses if no export bundle exists unless `--no-export`) | same verb | data deletion is always the user's verb, never a package side effect |
| Reinstall after purge | finds `/var/lib/bothy` intact and the key, and continues | same | proven: data survived remove, purge and a reinstall (VM) |
| Key creation | by `bothy install`, `O_CREAT|O_EXCL`, explicit `fchmod 0600`, never via the shell's umask | same | **found in the proof:** a key written by `tee` under the guest's default umask landed `0664`; the real code must not inherit umask |

### 4.4 Key custody for the apt/dnf repository (what real projects do, and what we do)

| Approach | Used by (MEMORY, not re-verified) | Failure mode | Verdict for Bothy |
|---|---|---|---|
| Private key as a CI secret | many small projects | a compromise of the repo's Actions or a malicious PR workflow exfiltrates the key, then the attacker signs anything, forever. HashiCorp rotated its signing key in 2021 after a third-party CI incident | **reject** |
| Key in a cloud KMS/HSM used by CI | larger organisations | key cannot be stolen, but **CI can still ask it to sign**, so a compromised workflow still ships signed malware | acceptable only with an approval gate; more setup than v1 needs |
| **Offline primary key + signing subkey on a hardware token (YubiKey OpenPGP card), signing done by the maintainer's machine** | Debian-style archives; careful single-maintainer projects | the release stalls if the token is lost or the maintainer is away (a bus factor, stated honestly) | **RECOMMENDED**. CI builds, a human signs. A compromised CI can publish *unsigned* metadata that apt rejects |
| Keyless / Sigstore | containers, language registries | **apt, dnf and apk cannot verify it** | not applicable to the package channel |
| Service-held key (PPA, OBS, COPR, Cloudsmith) | distros, vendors | the service is the root of trust | the named fallback (section 3.5) |

Details of the recommendation (D33): the primary key is `certify`-only, kept offline (paper or an air-gapped
USB, two copies, one off-site); a **signing subkey with a 1-year expiry lives on the token**; the `Release` file
carries `Valid-Until` (apt's `Check-Valid-Until`) so a stale or replayed index is refused (MEMORY, default behaviour
of apt, but the repo must set the field); `bothy-archive-keyring` ships the public keys and is itself signed by
the previous key, so rotation is an ordinary upgrade (the Debian page's recommendation, VERIFIED). The same key
signs rpms and metadata. **The fingerprint is published on a second surface** the owner controls (the docs site
and a pinned issue), as `security-model.md` 6.3 already asks for the installer hash.

### 4.5 Stopping a compromised or malicious release

| Layer | Mechanism | Time to effect |
|---|---|---|
| Not yet published | `release.yml` gate (green on one commit) + a `release` environment with a required reviewer | before the fact |
| Tarball users | the pin in `bothy.sh` (the next pin PR withdraws the bad version); `bothy-release.json` carries `revoked: [versions]` and `min-supported`, which `bothy update plan` and `bothy self update` check | one fetch of the manifest |
| Anti-rollback | the manifest's `min-supported` is a floor: the updater refuses to *apply* anything below it, and hostd **refuses to start against a settings DB with a newer schema version than it knows**, printing the fix. dpkg itself *allows* a downgrade (VERIFIED: v2 to v1 installed cleanly with `--allow-downgrades`), so safety lives in hostd, not in dpkg | at start |
| Package users | remove the bad version from the repository, re-sign, publish a higher fixed version (never reuse a version number); an apt client that already installed it needs the fix package | next `apt update` |
| Key compromise | publish a new `bothy-archive-keyring` signed with the old key **if the old key is still trusted**; if it is not, users must re-bootstrap the key by hand from the second surface. This is why the offline key matters: it makes this case rare | manual; document the runbook before shipping |
| Image compromise | images are pulled **by digest** from the signed manifest; a bad image is revoked by manifest, not by tag | one fetch |

Reconciling with the decisions: **scrub-forward (D9)** applies to the repository too: a bad release is superseded,
not rewritten, and nothing here rewrites history. **"Deploy only what is reviewed"**: the package contains no
stack, and the updater (not dpkg) still decides what runs (D29). **"Only the host CLI decrypts" (D11):** a package
never reads or writes the master key; no maintainer script touches `/etc/bothy/master.key`.

## 5. Distribution matrix, phases and tests

### 5.1 Do now, at near-zero cost, so every later channel is cheap (the "Phase P0" list)

| Item | Rule |
|---|---|
| **Names** | the binary is `bothy` and stays `bothy`; the host daemon is `bothy-hostd` (unit) and runs as `bothy hostd` or `bothyd`; **one name per thing, never renamed after a package ships** (a rename breaks `apt` upgrades; use `Replaces`/`Conflicts` only as a last resort). Package names: `bothy`, `bothy-host`, `bothy-archive-keyring` |
| **Binary layout** | `bothy` is a **single static binary**; its sub-modes (`mcp`, `hostd` shim) are subcommands, so one file is packaged and attested |
| **File layout (FHS)** | package install: `/usr/bin/bothy`; `/usr/lib/bothy/` (hostd code, `install-method`); `/usr/lib/systemd/system/bothy-hostd.service`; `/etc/bothy/` (config only); `/var/lib/bothy/` (state, spool, keys-dir); `/usr/share/bothy/` (read-only data); completions in `/usr/share/{bash-completion/completions,zsh/vendor-completions,fish/vendor_completions.d}`; man page in `/usr/share/man/man1` |
| **File layout (user install, XDG)** | `~/.local/bin/bothy`; config `$XDG_CONFIG_HOME/bothy`; state `$XDG_STATE_HOME/bothy` (or `$XDG_DATA_HOME`); cache `$XDG_CACHE_HOME/bothy`; **Windows:** `%APPDATA%`/`%LOCALAPPDATA%`; **macOS:** the XDG variables are honoured if set, else `~/Library/Application Support` |
| **No hardcoded paths** | every path comes from one resolver (`paths.Config()`, `paths.State()` ...) keyed by `BOTHY_*_DIR` env overrides; `scripts/checks/portability.sh` already forbids personal paths in this repo; add a check that forbids a literal `/var/lib/bothy` outside the resolver |
| **Version scheme** | section 3.2, enforced by a check |
| **Release assets** | `bothy_<version>_<os>_<arch>.tar.gz` (`.zip` for Windows), `checksums.txt`, SBOM, attestation, `bothy-release.json` with `host-layer`, `min-client`, `revoked`, `min-supported` |
| **Install receipt** | `install-method` file (4.1/1.3) from the first release that has a package |
| **Portable client** | no POSIX-only assumption in the client: no `fork`, no Unix socket as the *only* local transport, no `/proc`, no shelling out to `ls`, `ssh` found via PATH only when `bothy ssh` is used; `path/filepath` everywhere; line endings and `\r\n` tolerated; compile `GOOS=windows GOARCH=amd64` in CI from slice 1 (a 10-second job) and run only `bothy version` (the existing 2.2 plan) |
| **Image registry** | decide registry and tag policy now (D34); publish images multi-arch, **digest-pinned** in the manifest |
| **A deb is never the only way in** | every package install must have a documented tarball equivalent |

### 5.2 The distribution matrix

Legend: **CLI** = `bothy` only; **CLI+hostd** = client + host layer (`bothy` + `bothy-host`); **full** = the stack
too (it is *always* delivered by the updater, never by a package, so no channel's "full" is a package).
Phase: **v1** = the first Thin Bothy slice (with the existing D27); **v1.x** = the next step after slice 1;
**v2** = after the first installable Bivvy runs on the lab; **later** = no commitment.

| Platform | Channel | Contents | Phase | Verdict |
|---|---|---|---|---|
| Linux (any) | tarball + `bothy.sh` | CLI (+ hostd via `bothy install`) | **v1** | KEEP |
| Linux (any) | `mise` / `ubi` | CLI | **v1** (free, naming) | KEEP |
| Debian, Ubuntu, WSL Ubuntu | `.deb` as a **Release asset** | CLI+hostd | **v1.x** | KEEP |
| Debian, Ubuntu | **apt repository** (Pages, offline key) | CLI+hostd | **v2** | KEEP |
| Fedora, RHEL family | `.rpm` as a Release asset, then **dnf repo** | CLI+hostd | v1.x / **v2** | KEEP (same release) |
| Alpine | `.apk` as a Release asset | CLI+hostd (the below-4-GiB Compose host, D1) | v2 | DEFER |
| Alpine | signed apk repo | CLI+hostd | later | DEFER |
| Arch | AUR `bothy-bin` | CLI | later | DEFER |
| Nix / NixOS | flake in-repo; module | CLI (+ hostd by module) | later | DEFER |
| macOS and Linux (client) | Homebrew **tap** | CLI | v1.x | KEEP (client only; no root host layer) |
| macOS | notarised `.pkg` | CLI | later | DEFER (Apple 99 USD/yr, VERIFIED) |
| Windows | winget (portable zip), Scoop bucket | CLI only | later | FUTURE (section 6) |
| Windows | Chocolatey, MSI, MSIX | CLI | never (v1) | REJECT |
| Windows (WSL2 guest) | the Linux packages **inside** the guest | CLI+hostd | after S12b | FUTURE |
| Any | Flatpak, Snap, AppImage | CLI at most | never | REJECT |
| Any | OCI `docker run bothy` as installer | CLI | never | REJECT (a CI-only client image: DEFER) |
| Any | PPA / COPR / OBS | CLI+hostd | only if key custody blocks | FALLBACK |
| Any | **stack and images** | full | **v1** | always by the updater from the signed release (D29, D34) |

### 5.3 What was proven today, in the lab (small, inside the guest only)

Setup: lab guest `lab-mini` (Ubuntu 24.04.5 LTS, 2 GiB, the existing disk, **not reset**), started and then stopped
with `lab.sh down`; `lab.sh check` passed while another spike held the larger profile, so the memory gate was met.
Tool: **nfpm 2.49.0 downloaded on the host and its checksum verified against the release `checksums.txt`**; no
package was installed on the host. A stub package `bothy` (a shell script as `/usr/bin/bothy`, a hardened systemd
unit, one conffile, the four maintainer scripts of section 4.1). **Nothing was committed** beyond the numbers here.

| Step | Result |
|---|---|
| One nfpm YAML, three formats | deb 1.6 kB, rpm 3.3 kB, apk 1.9 kB (stubs); a second deb at the next version for upgrade tests |
| `apt-get install ./bothy_2026.11.1_amd64.deb` on a clean guest | installed; system user `bothy` (uid 109) created; `/var/lib/bothy` is `drwxr-x--- bothy bothy`; `systemctl is-enabled` = `disabled`, `is-active` = `inactive` (**nothing started**); `bothy` runs |
| `systemd-analyze verify` on the unit | clean (no output) |
| Admin appended a line to the conffile; a stand-in key file written into `/var/lib/bothy` | (setup for the next rows) |
| Upgrade to `.2` | `ii bothy 2026.11.2`; the edited conffile kept |
| Downgrade to `.1` with `--allow-downgrades` | `ii bothy 2026.11.1`; the conffile still kept (dpkg **allows** downgrade; the safety must live in hostd, 4.5) |
| `apt-get remove` | `/usr/bin/bothy` gone; `/etc/bothy` and `/var/lib/bothy` stay |
| `apt-get purge` | `/etc/bothy` removed **by my postrm's `rm -rf`** (the bug to avoid: it would take the root-install master key); `/var/lib/bothy` (with a stand-in key file) and the `bothy` user stayed |
| Reinstall after purge | `/var/lib/bothy` content intact |
| Incidental | a key file created with `tee` under the guest's umask was `0664`: create keys with explicit modes |

**Not proven:** a real repository (no signed `InRelease` was built), `lintian`/`rpmlint`, the rpm and apk installs
on Fedora and Alpine guests (no such base image in the lab yet), upgrading while a hostd job runs, `needrestart`
behaviour, and WSL.

### 5.4 The acceptance test plan (to build when the first package ships)

Guests: Debian 12, Debian 13, Ubuntu 24.04 (exists), Fedora (current), Alpine (current). `lab.sh fetch` knows only
the Ubuntu image, so each additional guest is a small, checksum-verified base-image addition to the lab (the existing
rule: no unverified image). Memory: `lab-mini` (2 GiB) is enough; k3s is **not** needed to test packaging.

| # | Test | Pass condition |
|---|---|---|
| T1 | clean install of `bothy` only | no maintainer script ran (`dpkg -c` has none; rpm `--scripts` empty); binary on PATH |
| T2 | clean install of `bothy-host` | user and state dir created; **nothing enabled, active or listening** (`ss -ltnp` unchanged) |
| T3 | install with `--no-install-recommends`; with no network | same result (no script touches the network) |
| T4 | upgrade N to N+1 while a stub hostd job runs | job completes; hostd not restarted by the package; restarts when idle |
| T5 | conffile edited, then upgrade and downgrade | edit preserved; no prompt on non-interactive (`DEBIAN_FRONTEND=noninteractive`, `--force-confold`) |
| T6 | downgrade N+1 to N with a newer settings schema present | hostd **fails closed** with the documented message; data untouched |
| T7 | remove, then purge | `/var/lib/bothy` and the master key survive both; only conffiles go on purge |
| T8 | reinstall after purge | picks up the data and key; `bothy status` works |
| T9 | repository: add the keyring, `apt update`, install | `signed-by` file used; **no** `apt-key`; no warning |
| T10 | repository: tampered `.deb`, tampered `Packages`, an expired `Valid-Until`, and an `InRelease` signed by a different key | each is **refused** by apt |
| T11 | `self update` on a package install | refuses, naming `apt upgrade` |
| T12 | rpm and apk equivalents of T1 to T8 | same results on Fedora and Alpine |
| T13 | `lintian` and `rpmlint` | no errors (warnings listed and accepted one by one) |
| T14 | a stack release outside the installed host range | `update plan` refuses with the package command (1.3) |

## 6. Windows and macOS (the future, written down so it stays possible)

### 6.1 What "install on Windows" can mean

| Meaning | Realistic? | How |
|---|---|---|
| **A. A Windows client that manages a box** (remote Linux, or WSL2 on the same machine) | **Yes, and it is the only honest v1 meaning** | a static `bothy.exe` (Go cross-compiles trivially; Rust needs a target and no MSVC for `x86_64-pc-windows-gnu`, ASSUMPTION), a **context** pointing at the box's tailnet or LAN address and a token file (`cli-and-control-plane.md` 2.10), and the **MCP stdio server** run by an agent on Windows (`bothy mcp`). **WSL2 specifically:** the owner's box *is* a WSL2 distro that is its own tailnet node, so a Windows `bothy.exe` needs **no WSL integration**; it is simply a remote client. A tiny helper to find the WSL distro's address is a convenience, not a dependency |
| **B. The whole stack on Windows, inside WSL2** | **Possible, not native**: install the *Linux* package inside the WSL2 distro; requires systemd enabled in the distro (it is on the owner's box) and the unproven WSL items in the go/no-go table (S12b, rshared persistence, k3s on the WSL kernel). Windows then only needs `wsl --install` and a keepalive. A future `bothy.exe wsl install` that runs the Linux installer in a distro is a thin wrapper (ASSUMPTION; unscoped) |
| **C. The stack running natively on Windows** (k3s or Docker without a Linux VM) | **No.** k3s is a Linux-only distribution; Windows runs Linux containers only through a VM or WSL2. Not planned, not designable here |

### 6.2 Packages and signing for the client (the cost table)

| Item | Facts | Verdict |
|---|---|---|
| **winget** | A manifest PR to `microsoft/winget-pkgs`; automated validation (manifest schema, URLs, AV scan, silent install/uninstall) then a moderator; the **installer URL must come directly from the publisher's release location** with HTTPS and no redirector (all VERIFIED, Microsoft Learn "Submit your manifest"). A GitHub Release URL qualifies (ASSUMPTION: GitHub counts as the publisher's location; the page says "directly from the ISV's release location"). An archive-based "portable" installer type avoids an MSI (MEMORY) | FUTURE: the right first Windows channel |
| **Scoop** | a JSON manifest in a bucket repo we own; no review | FUTURE: free, optional |
| **Chocolatey** | nuspec packaging, community moderation queue | REJECT for v1 (a second review queue for the same user) |
| **MSI / MSIX** | an installer for a CLI adds nothing winget's portable type does not; MSIX needs a trusted signature (nfpm can *emit* MSIX, VERIFIED, which is not the same as being installable) | REJECT for v1 |
| **Azure Artifact Signing** (renamed from "Trusted Signing" in the docs; VERIFIED page title) | fully managed, certificates held in FIPS 140-3 level 3 HSMs and **never given to you**; needs a **paid Azure subscription** (free, trial and sponsored are refused: VERIFIED); identity validation for an **individual** or an organisation, limited to listed countries (not verified for the owner's country); **does not issue EV certificates** and says it never will (VERIFIED); certificate CN must be the validated legal name (VERIFIED); price per month is on a separate page not fetched (MEMORY: a low monthly fee) | the leading option for an individual; check country eligibility and the price before committing |
| **SignPath Foundation** | free code signing for open-source projects: OSI-approved licence **without commercial dual-licensing**, no proprietary component, actively maintained, already released in the form to be signed, authors/reviewers/approvers defined with MFA, a published code-signing policy, **only your own code** (all VERIFIED, signpath.org terms). Whether Bothy's licence qualifies is the owner's fact (ASSUMPTION: the repo is public; its licence was not checked here) | the free alternative; check the licence |
| **EV certificate** | hundreds of USD per year, a hardware token, an identity check; since 2024 SmartScreen no longer treats EV as instant reputation (MEMORY) | not worth it for a CLI |
| SmartScreen reputation | builds with download history per file hash and signing identity (VERIFIED in the Artifact Signing FAQ: "reputation builds up automatically") | expect warnings early on |

### 6.3 macOS

* A **Homebrew tap** (CLI) and `bothy.sh` need **no Apple fee**: a Go binary on arm64 is ad-hoc signed by the
  linker (MEMORY), and files fetched by `curl` or `brew` do not carry the browser's quarantine attribute (MEMORY),
  so Gatekeeper does not block them. A browser-downloaded tarball does get quarantined, which is the case that
  notarisation exists for.
* **Notarisation** needs the Apple Developer Program: **99 USD per year** (VERIFIED, with fee waivers only for
  nonprofits, schools and government), a Developer ID certificate, `notarytool`, and a macOS CI runner. It is worth
  it only if a `.pkg` or a browser download becomes a promised path. **FUTURE.**
* macOS is also a client only: no k3s, no Docker host layer. The box is elsewhere.

### 6.4 What to do now so this stays possible (short)

1. Build `windows/amd64` and `darwin/arm64` in CI from slice 1; run `bothy version` on them.
2. All paths through one resolver (5.1); no Unix-socket-only local transport; no reliance on `$HOME`, `/proc`,
   `ps`, `sh`.
3. Tokens live in a file or the OS credential store behind an interface (`0600` on Unix; an ACL-restricted file on
   Windows; Keychain on macOS later). The CLI never takes a token in argv (already in 2.10).
4. The release manifest and API are OS-independent; **no client behaviour depends on the host being Linux**, except
   `host-only` verbs, which already refuse remotely.
5. Name release assets `bothy_<version>_windows_amd64.zip`, `..._darwin_arm64.tar.gz` now.
6. Leave the winget, Scoop and Homebrew-tap repository names reserved (an empty repo costs nothing; an
   impersonating repo later costs a lot).

## 7. What this means for the CLI language (Go versus Rust), objectively

A parallel engineer is measuring the two languages (`cli-language-reassessment.md` may appear). This section only
says which **packaging** tools favour which, and does not decide.

| Concern | Go | Rust |
|---|---|---|
| Deb/rpm/apk/Arch/MSIX | nfpm (language-agnostic, VERIFIED) | nfpm too, or `cargo-deb` / `cargo-generate-rpm` |
| One-tool release pipeline | GoReleaser (archives, nfpm, SBOM, signing, brew, scoop, winget, AUR, Nix, Docker; MEMORY on exact pipe set and which are Pro) | cargo-dist (installers, Homebrew, MSI, npm; MEMORY) |
| Cross-compiling to Linux amd64/arm64, macOS, Windows | `GOOS`/`GOARCH`, no extra toolchain | needs targets and, for musl or macOS, a linker (`cross`, `cargo-zigbuild`); more CI work |
| Static binary | default with `CGO_ENABLED=0` | musl target |
| Reproducibility | `-trimpath` plus a pinned toolchain | `--remap-path-prefix`, `Cargo.lock`, a pinned toolchain; linker and libc choice are extra variables |
| SBOM and provenance | syft or `cyclonedx-gomod`, attestations | `cargo-cyclonedx`, attestations |
| Windows Authenticode | `osslsigncode`/`signtool` on the output | same |

**Objective result:** packaging does not separate them, because nfpm packs finished files. Go gets a **shorter
path** (GoReleaser, free cross-compilation); Rust has an equivalent (cargo-dist) with more CI configuration for
non-native targets. Language choice should rest on the MCP SDK evidence and the contributor cost already weighed
in `cli-and-control-plane.md` 2.1.

## 8. Decisions for the owner (D29 onward)

D15 to D28 are in `cli-and-control-plane.md` (still **Proposed**). These continue the numbering. Every one is
**Proposed, needs owner**.

| Id | Decision | Recommendation | Evidence | If you disagree |
|---|---|---|---|---|
| D29 | **Who owns version upgrades** | The package manager owns the host layer (`bothy`, `bothy-host`); the Bothy updater owns the stack and images; a signed manifest declares the compatible host-layer range; `bothy self update` refuses on a package install | 1.2 table, 1.3; `updates.toml` gates | A (package owns the stack): `apt upgrade` bypasses the class gates, the window and rollback. C (all pulled): root code fetched at runtime |
| D30 | **Package set** | `bothy` (client, no scripts), `bothy-host` (hostd, units, user; depends on `bothy` same version), `bothy-archive-keyring`; no stack package | 2.1, 4.1; zero-script client is the best supply-chain posture | One package: the laptop client then carries root scripts and a system user |
| D31 | **Amend D27** (packages not in v1) | Keep "none in slice 1". Next: `.deb`/`.rpm`/`.apk` as Release assets (no repo, no key). Then the repo, once the key ceremony is done | 3.5, 4.4; the owner's requirement | Skip the asset step: the repo and its key become a blocker for the first package. Or keep D27 as is: the requirement is deferred |
| D32 | **Repository hosting for v1 of packages** | GitHub Pages in a separate repo, on a domain you control; Cloudsmith as fallback | 3.5 (limits VERIFIED) | OBS/COPR if you would rather not hold a signing key at all |
| D33 | **Key custody** | Offline OpenPGP primary + 1-year signing subkey on a hardware token; the maintainer signs the metadata; CI never holds it; fingerprint on a second surface | 4.4 | Service-held key (OBS/PPA/Cloudsmith): less toil, a platform as the root of trust. CI-held key: rejected |
| D34 | **Publish images to a registry, pulled by digest** | Yes: GHCR (ASSUMPTION: free for public images), multi-arch, attested; the updater pulls instead of building from a checkout. Prerequisite for *any* package-installed Bothy | 1.1: images are built from the checkout today | Keep building on the box: then a package must also ship a source tree (a checkout in `/usr/share`), which defeats D29 |
| D35 | **Tooling** | nfpm for packages; GoReleaser if the CLI is Go (cargo-dist if Rust); keep `release.yml` and `release-decision.sh`; do not add release-please or fpm | 3.1, 7 | |
| D36 | **Channel verdicts** | Keep: tarball, `mise`, deb, rpm, Homebrew tap (client). Defer: AUR, Nix, Alpine repo, macOS pkg, winget/Scoop. Reject: Flatpak, Snap, AppImage, OCI-as-installer, Chocolatey, MSI/MSIX, distro-official | 2.2 | Snap if you want Ubuntu reach and accept store-forced refresh and a classic review |
| D37 | **Data and key survival, and install modes** | Remove and purge never delete `/var/lib/bothy` or the master key; only `bothy uninstall --data`; package install = system user `bothy` and `/var/lib/bothy`; tarball install = user and XDG; one code path via a path resolver | 4.2, 4.3, VM proof | A purge that deletes data (Tailscale's choice): an unrecoverable settings DB |
| D38 | **Windows and macOS scope** | Client only; `windows/amd64` and `darwin/arm64` built in CI now; winget/Scoop and a notarised pkg later; WSL2 = the Linux package inside the guest | 6 | Native stack: not possible (no k3s on Windows) |
| D39 | **Revocation and anti-rollback** | `bothy-release.json` with `revoked` and `min-supported`; hostd fails closed on a newer settings schema; never reuse a version number | 4.5 | dpkg alone permits downgrades (VERIFIED) |

**Does any decided item (D1 to D14) break?** No. **D1/D13** (k3s floor, Compose below it): the Alpine `.apk` fits the
below-4-GiB Compose host. **D6** (VM first): all tests use the lab. **D11** (key outside the datastore, only the host
CLI decrypts): kept, with the purge rule as the new guard. **D14** (hostd): moves from a user-level unit to an
optional system unit; same code. **Proposed items touched:** D22 (signing) gains the OpenPGP archive key; D27 is
amended by D31; D17 (hostd stays Python) means `bothy-host` declares `Depends: python3 (>= X)`, with X to be
measured (ASSUMPTION: Debian 12 ships 3.11, Ubuntu 24.04 ships 3.12, so the floor must be at most 3.11 unless the
host package bundles an interpreter).

## 9. Sources

* Debian wiki, third-party repositories: <https://wiki.debian.org/DebianRepository/UseThirdParty> (fetched 2026-11-16)
* Tailscale package repository (`Release`, keyring list, the `.deb` maintainer scripts), VS Code repository `Release`
  (aptly), Docker `Release`, Chrome `Release`, GitHub CLI `Release`: all fetched directly from the vendors' hosts on 2026-11-16
* nfpm 2.49.0 release and `checksums.txt` (<https://github.com/goreleaser/nfpm>), downloaded and checked 2026-11-16
* Flathub requirements: <https://docs.flathub.org/docs/for-app-authors/requirements>; Flatpak sandbox permissions: <https://docs.flatpak.org/en/latest/sandbox-permissions.html>
* Homebrew Acceptable Formulae: <https://docs.brew.sh/Acceptable-Formulae>
* winget submission: <https://learn.microsoft.com/en-us/windows/package-manager/package/repository>
* Azure Artifact Signing overview and FAQ: <https://learn.microsoft.com/en-us/azure/artifact-signing/overview>
* SignPath Foundation terms: <https://signpath.org/terms>
* GitHub Pages limits: <https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>
* Apple Developer Program: <https://developer.apple.com/programs/whats-included/>
* **Not verified:** Snap classic-confinement review rules and auto-refresh control (the Canonical docs sit behind a
  login); Cloudsmith's open-source terms (HTTP 429); Azure Artifact Signing price and country list; the Homebrew-core
  notability numbers; GoReleaser's exact pipe list and which are Pro; whether `reprepro` can sign in a separate step;
  Chrome's and VS Code's postinst behaviour (MEMORY); unattended-upgrades' default origins; hosted arm64 runner
  availability; nfpm reproducibility; Alpine and Fedora behaviour (no guest image in the lab).

## Changed 2026-11-16

First version. Proposes D29 to D39 and risks R26 onward in `risks-and-open-questions.md`. Nothing built; one small
install proof in the lab guest (section 5.3), whose files were not committed.
