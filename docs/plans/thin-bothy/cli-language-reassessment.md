# D15 reassessed: Go or Rust for the `bothy` CLI (and anything else)

**Status:** evidence for the owner, 2026-11-16. It re-examines D15 of `cli-and-control-plane.md` (section 2.1)
after the owner said Rust is acceptable "if it makes things faster and better", and that the product will later
ship as native packages on more platforms. It changes no other document.

## 0. The answer

**Recommendation: keep D15, Go static thin client, with three corrections to section 2.1 and one new guard rail.**
Rust wins every number a *user* could feel (binary 3.4x smaller, start-up 3x faster, idle MCP server 3x smaller),
and I would pick it for a daemon; it loses on what *one maintainer plus AI contributors* pay for across five
platforms: a release toolchain that needs no extras (Go built all five targets from this box with no setup; Rust
failed four of four without a C cross toolchain and could not do macOS at all), a dependency surface of 11 modules
instead of 113 crates, and an MCP SDK that has shipped 18 releases in 15 weeks against Go's two.

Both options are far inside the budgets already written down (start-up under 50 ms, binary under 25 MiB), so the
speed and size win does not buy anything a user will notice. **No component of the product needs Rust** (section 4).

Corrections to section 2.1 of `cli-and-control-plane.md` (not made there, by instruction):

1. **The Rust SDK does serve the 2026-07-28 spec.** The table's ASSUMPTION is wrong. `rmcp` 3.0.0 shipped on the
   spec's own release day (2026-07-28) and answered `server/discover` with `2026-07-28` first-class in the
   prototype below. The changelog line quoted there, "reject requests to 2026-07-28 clients", is about
   server-to-client requests, which the new spec replaced with multi round-trip requests. The SDK is not the
   deciding fact; Go no longer wins on it.
2. **Plain `go build` on this box is not static.** The prototype built with default settings is
   `dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2` (the `net` resolver pulls in libc). The plan's
   "static binary" needs `CGO_ENABLED=0` stated explicitly in the release job.
3. The size estimate "about 10 to 16 MB stripped" for a Go client was too high: measured **9.1 MB** with cobra and
   the MCP SDK, 7.3 MB without the SDK.

## 1. What was built

The same thin client twice, in a scratch directory outside the repository (deleted afterwards):

| Feature | Go (about 170 lines) | Rust (about 195 lines) |
|---|---|---|
| `status`, human and `--json`, exit codes 0, 3, 4, 5, 10 | `net/http`, `encoding/json` | `ureq` 3 (blocking), `serde_json` |
| `completion bash/zsh/fish` | cobra's built-in | `clap_complete` |
| `version` | `-ldflags -X` | `CARGO_PKG_VERSION` |
| `self update-check` (fetch `checksums.txt`, verify sha256 of an artifact) | stdlib `crypto/sha256` | `sha2` |
| `mcp` stdio server, 2 read-only tools | `modelcontextprotocol/go-sdk` v1.8.0 | `rmcp` 3.10.0 (`server`, `transport-io`, `macros`), tokio current-thread |
| CLI parsing | cobra 1.10.2 | clap 4.6.7 (derive) |

A Python mock server returned the section 1.3 envelope (`ok`/`data`/`error`), a 409 `scope.group-available`
error and a `checksums.txt`. Both clients produced the same human output, the same `--json` shape, the same exit
codes (5 when unhealthy, 10 when the server is unreachable) and the same checksum verdict.

**MCP conformance, tested by a hand-written JSON-RPC client over stdio** (legacy `initialize` at 2025-11-25, then
the stateless 2026-07-28 shape: `server/discover` and `tools/list` / `tools/call` with the version and client
capabilities in `_meta`, no `initialize`):

| | Go SDK 1.8.0 | Rust `rmcp` 3.10.0 |
|---|---|---|
| `server/discover` supportedVersions | 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 | the same five |
| `tools/list`, `tools/call` at 2026-07-28 | works; result carries `resultType`, `ttlMs`, `cacheScope` | works; same fields |
| legacy 2025-11-25 `initialize` | works | works |
| a bug I wrote | first run failed at **call time**: a `json.RawMessage` field makes the SDK infer an `array` output schema and the object result is rejected ("has type object, want one of null, array"). Fixed by using `map[string]any` | none, but the macros need `schemars` types for typed arguments; the compiler reports misuse |

Neither SDK needed hand-written protocol code, so the "what would writing it by hand cost" question does not arise.

## 2. Measurements

Box: WSL2, 10 logical CPUs, 24 GiB RAM, a busy host (other containers running, so absolute times are noisy and
the *ratios* are what to read). Toolchains: go 1.27.4, rustc 1.100.0 (2026-11-09), hyperfine 1.20.0, zig 0.17.1,
cargo-zigbuild 0.24.1, govulncheck 1.9.0 (Go vuln DB), cargo-audit 0.23.0 (1509 advisories).
Both toolchains were run through `mise x` and nothing used sudo.

### 2.1 Size, start-up, memory (linux/amd64, full client with MCP)

| | Go | Rust |
|---|---|---|
| Release binary, no flags | 13.5 MB | 13.5 MB (opt 3, no strip) |
| Stripped, usual flags | **9.13 MB** (`-trimpath -ldflags '-s -w'`) | **2.67 MB** (`opt-level=z`, lto, `codegen-units=1`, `panic=abort`, `strip`); 3.72 MB with `opt-level=3`; 5.50 MB strip only |
| Same, without the MCP SDK | 7.29 MB | 1.88 MB |
| `bothy version`, p50 / p99 (200 runs, `hyperfine -N`) | 3.51 ms / 10.6 ms | 1.18 ms / 5.7 ms (opt 3: 0.78 / 4.5) |
| `bothy status` against the mock, p50 / p99 | 4.31 ms / 13.0 ms | 2.38 ms / 8.0 ms |
| Idle RSS of `bothy mcp` (after initialize and 2 calls) | **12.0 MB** | **4.0 MB** |
| For scale: `python3 -I -c pass` / with `json, urllib.request, hashlib, argparse` imported | 13.8 ms / **44.1 ms** p50 | |
| For scale: an idle stdlib-only Python `http.server` | 20.8 MB RSS | |

Both are far inside the proposed `bothy version` under 50 ms budget. The Python figure matters for the zipapp
option (section 3.8): importing what a client needs already costs 44 ms.

### 2.2 Build time (this box, modules and crates already downloaded)

| | Go | Rust |
|---|---|---|
| Clean release build | 29.9 s (empty GOCACHE) | 65.9 s (size profile with fat LTO) |
| Incremental release rebuild after an edit | **1.6 s** | **58.6 to 69.7 s** (fat LTO relinks everything) |
| Clean dev (debug) build | n/a (Go has one mode) | 36.7 s |
| Incremental dev rebuild | 1.6 s | 0.6 s (comment-only edit, so a best case) |
| `cargo check` / `go vet`, cold | 28.7 s (vet, cold cache) | 16.3 s |

The honest reading: Rust's *dev-profile* loop is as quick as Go's; its **release-profile** loop is what hurts,
and a release build is what the size flags produce. A contributor or an AI agent that only runs `cargo build` and
`cargo test` in the dev profile is not penalised. A CI job that builds the shipped artifact is.

### 2.3 Dependencies

| | Go | Rust |
|---|---|---|
| Direct | 2 (cobra, go-sdk) | 9 (clap, clap_complete, serde, serde_json, sha2, hex, ureq, rmcp, tokio) |
| Transitive modules or crates actually built | **11** modules, 32 non-stdlib packages | **113** distinct crates (63 without the MCP SDK); 134 `Cargo.lock` entries |
| Lock or checksum file | `go.sum`, 34 lines | `Cargo.lock` |
| Includes C code | none | `ring` (TLS crypto) compiles C and assembly |

### 2.4 Cross-compilation from this box, no Docker

| Target | Go (`CGO_ENABLED=0`, one command) | Rust, plain `cargo build --target` | Rust, `cargo-zigbuild` + zig 0.17.1 |
|---|---|---|---|
| linux/amd64 | 9.09 MB, 5.6 s | native | native |
| linux/arm64 | 8.39 MB, 12.4 s | **fails**: `ring` wants `aarch64-linux-gnu-gcc` | 2.26 MB, 60 s |
| linux/amd64 musl (static) | not needed | **fails**: `x86_64-linux-musl-gcc` | 2.67 MB, 56 s |
| windows/amd64 | 9.39 MB, 11.9 s | **fails**: `x86_64-w64-mingw32-gcc` | 2.46 MB `.exe`, 67 s (gnu ABI; msvc not tried) |
| darwin/arm64 | 8.65 MB, 15.7 s (darwin/amd64 also 9.32 MB) | **fails**: host `cc` rejects `-arch` | **fails**: needs an Xcode SDK (`SDKROOT`), which means a macOS runner or an SDK we may not redistribute |

Rust needed: `rustup target add` per target (written into the shared toolchain), `cargo install cargo-zigbuild`,
and zig. The failures are mostly `ring`'s C build; a pure-Rust TLS backend would remove them, but self-update
needs HTTPS and Go's stdlib already has it. aarch64-musl was not tried (the target was not added), so it is
unmeasured, not failed.

### 2.5 Reproducibility, same toolchain, two checkouts in different directories

| | Go | Rust |
|---|---|---|
| Default flags | **differs** without `-trimpath` | identical hash |
| `-trimpath` / `--remap-path-prefix` | identical hash | identical hash |

So Go needs `-trimpath` (already in the plan); Rust was reproducible on one machine and one toolchain, with or
without path remapping, **not tested across machines or toolchain versions**, which is where Rust usually bites
(embedded registry paths, linker and C compiler versions through `ring`).

### 2.6 Vulnerability scanners

`govulncheck` ./...: **0 reachable vulnerabilities**; it reports one in a *required but uncalled* module,
GO-2026-5024 in `golang.org/x/sys@v0.41.0`, fixed by a version bump. `cargo audit`: **0 findings** across 134
crates (its index refresh warned and failed, the 1509-advisory database loaded). Both tools installed without
sudo in a scratch root.

### 2.7 Commands

```
mise x go@1.27.4 -- go get github.com/spf13/cobra@latest github.com/modelcontextprotocol/go-sdk@latest
mise x go@1.27.4 -- go build -trimpath -ldflags '-s -w -X main.version=0.1.0' -o bothy-go .
mise x go@1.27.4 -- go build -trimpath -ldflags '-s -w' -tags nomcp .              # without the SDK
GOOS=<os> GOARCH=<arch> CGO_ENABLED=0 mise x go@1.27.4 -- go build -trimpath -ldflags '-s -w' .
mise x rust@1.100.0 -- cargo build --release                                       # profile below
CARGO_PROFILE_RELEASE_OPT_LEVEL=3 CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
  CARGO_PROFILE_RELEASE_PANIC=unwind CARGO_PROFILE_RELEASE_STRIP=none cargo build --release   # "no flags" row
cargo build --release --no-default-features                                        # without rmcp and tokio
CARGO_TARGET_DIR=<dir> mise x rust@1.100.0 zig@latest -- cargo-zigbuild zigbuild --release --target <triple>
hyperfine -N -i --warmup 20 --runs 200 --export-json out.json "<binary> version"   # p50, p99 from the samples
govulncheck ./...      cargo audit      cargo tree -e normal --prefix none -f '{p}' | sort -u | wc -l
```

```toml
# Cargo.toml release profile used for the size row
[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

Side effects I should disclose: mise's Rust defaults `CARGO_HOME` and `RUSTUP_HOME` to the user's home, so the
crate registry, the advisory database and four rustup targets were written there. No shell or tool config was
edited.

## 3. Comparison on what decides it for one maintainer

### 3.1 MCP SDK maturity

| | Go SDK | Rust `rmcp` |
|---|---|---|
| Official repository | `modelcontextprotocol/go-sdk`, v1.8.0 (2026-09-14), 5.3k stars | `modelcontextprotocol/rust-sdk`, rmcp 3.10.0 (2026-11-12), 4.1k stars |
| Current spec | v1.7.0 added 2026-07-28 on the spec's day | 3.0.0 added 2026-07-28 the same day, with a migration guide |
| Releases since 2026-07-28 | 2 stable (1.7.0, 1.8.0) plus pre-releases | **18** (3.0.0 to 3.10.0 including patch releases) |
| Versioning signal | v1.x (a stable major; I did not audit its changelog for breaks) | 3.0 was breaking against 2.x (sessionless HTTP, `stateful_mode` renamed, discover lifecycle) |
| Dependencies it adds | most of the 11 modules in the build | about 50 crates |
| Pushed | 2026-11-16 | 2026-11-16 |

Both are alive. The difference is **churn**: a weekly minor bump of a protocol SDK is a weekly Dependabot PR for a
solo maintainer, and `rmcp` has a macro layer (`#[tool_router]`, `#[tool_handler]`) whose changelog includes
"document the Send limitation on async `#[tool]` bodies". Sources: the two release pages, section 5.

### 3.2 HTTP, JSON, CLI parsing, error ergonomics

For a thin client both are mature. Go's `net/http` and `encoding/json` are the standard library: no dependency,
TLS and proxy support included. Rust's `ureq` is fine and blocking, but TLS means picking a crypto backend (this
is what introduced C and the cross-compile failures). Errors: Rust's `Result` and typed enums are better at
making the exit-code mapping exhaustive, and I would credit that honestly; in Go the mapping is a string-prefix
switch (as in the prototype) that a contract test must hold. The one runtime surprise found was Go's schema
inference at call time (section 1), the kind of defect a typed table test catches in minutes.

### 3.3 Does a thin client need async?

No. Every operation is one request and one response; `status` is blocking in both prototypes. Go hides
concurrency in the runtime at no cost to the author. Rust's blocking `ureq` is enough for the CLI, but **`rmcp`
requires tokio**, so the MCP half drags in an async runtime and the `Send` rules that come with it. A solo
maintainer pays for async in Rust only because of the SDK.

### 3.4 Build and release tooling

| | Go: GoReleaser | Rust: cargo-dist and friends |
|---|---|---|
| Project health | v2.21 nightly, pushed 2026-11-15 | cargo-dist v0.34.0 (2026-11-02), **pre-1.0**; `cross` last released 2023-02 (v0.2.5), main still active |
| tar/zip, checksums, SBOM, attestation, cosign | yes | yes (attestation and SBOM supported) |
| deb, rpm, apk | yes, via nfpm | **not in cargo-dist**; separate `cargo-deb` or `cargo-generate-rpm` |
| Homebrew, Scoop, winget manifests | yes (OSS) | Homebrew yes; winget and Scoop not in its installer list |
| MSI | **GoReleaser Pro only** (`g_featpro` in its docs) | yes (`installers/msi`) |
| macOS notarize | yes | not in scope; done by hand |
| Cross-compile in one job | `GOOS`/`GOARCH` | zig and a macOS runner (section 2.4) |

Neither is free: the `.msi` and Windows story is the one place Rust's tooling is ahead, and it is a "later"
platform. Linux packages, which are first, are better served by GoReleaser.

### 3.5 Supply-chain surface

11 modules against 113 crates (with C code in the TLS crate). Go's checksum database (`sum.golang.org`) and
`go.sum` are on by default; Cargo has `Cargo.lock` and RustSec but no equivalent default transparency log.
Vendoring is possible in both (`go mod vendor`, `cargo vendor`). The review cost scales with the dependency
count, and the plan's rule "a new direct dependency needs a line in the PR" is much easier to keep at 2 than 9.

### 3.6 Compile cost for contributors and AI loops

Section 2.2. Go: 1.6 s edit to binary, one profile. Rust: 0.6 s dev, 59 to 70 s for the shipped profile. An agent
that does edit, build, run against the mock server stays in Rust's fast profile, so this is a draw for the inner
loop and a Go win for CI and release verification.

### 3.7 Peer tools, from the repositories' GitHub language data (queried 2026-11-16)

| Go | Rust |
|---|---|
| docker compose, tilt, flyctl, talos (`talosctl`), k3s, nomad, gh | uv, ruff, ripgrep, zellij, just |

The split is by job, not fashion: the Go set are API clients and orchestrators that talk to Docker, Kubernetes or
a cloud and reuse those ecosystems' Go libraries; the Rust set do heavy local work (parse, resolve, search, render
a terminal). I found no repository README that states a language rationale beyond speed claims, so the *why* is
my inference, not a citation. `bothy` is in the first group: it talks to an API.

FFI and embedding: none expected in either option. The CLI links no native library, and its one native need (TLS)
is in Go's standard library.

### 3.8 The two non-compiled options, once more

**Python single-file zipapp.** The host has Python 3.12 so nothing needs installing there, and contributors know
it. But it is not a self-contained artifact: it needs an interpreter, which a laptop or a Windows client may not
have, and measured start-up with the imports a client needs is **44 ms p50** (62 ms p99) against 3.5 ms for Go and
1.2 ms for Rust, with 21 MB idle RSS. It cannot be a native package on Windows or macOS without bundling a
runtime. **It remains the right choice for `bothy-hostd`, not for the CLI.**

**Keep bash.** 1.1 ms start-up, nothing to build. But it cannot speak the stdio MCP protocol sanely, cannot
verify a signature or checksum portably without external tools, and does not exist natively on Windows. It stays
as the installer (`bothy.sh`) and the `just` recipes, as the plan already says.

## 4. Would Rust make anything else faster or better?

The owner's question, taken component by component. Evidence: the measured figures in `footprint-and-budgets.md`
and `resource-management.md`, and the code under `apps/`.

| Component | Bottleneck today | Would Rust help measurably? |
|---|---|---|
| CLI | one HTTP round trip | No: 3.5 ms against 1.2 ms is below perception and far under the 50 ms budget. Smaller binary (9 vs 2.7 MB) is real but not a constraint |
| `bothy-hostd` and `bothy-ops` (Python) | Docker API, `git`, `systemctl`, HTTP calls; I/O and subprocess bound | No CPU-bound path found. Memory: `bothy-ops` measured 33 MiB; a Python process floor is about 21 MiB (measured stdlib server), so a rewrite could save perhaps 20 to 25 MiB, **2 to 3 % of the 1.0 GB mini target** |
| Web API | same process as above | No |
| Settings store library | SQLite plus AES-256-GCM through the `cryptography` package, which **is already native code** (Rust and OpenSSL underneath) | No: the crypto cost is already paid natively; the rest is a few rows |
| Installer and preflight | shell, `docker`, `curl` | No; Rust cannot replace shell for what it does and would add a binary to bootstrap |
| Collectors and exporters (`bothy-collector`, about 1100 lines Python) | shells out to `docker`, `systemctl`; 8 subprocess calls | No |
| In-cluster updater Job | a `kubectl` or `git` operation in a container | No: image pull time dominates; a Rust binary would shave megabytes of a layer, not seconds |

**The honest answer: no component is CPU-bound and none needs Rust.** The only measurable benefit is resident
memory of small daemons (Go 12 MB, Rust 4 MB, Python 21 MB idle for a minimal server), worth chasing only if the
mini budget stops closing. The repository's 10.6 thousand lines of Python under `apps/` would be the rewrite cost.

What a second language costs regardless of which: a CI job per platform; one more Dependabot ecosystem next to
npm, pip, docker, compose, helm and actions (`gomod` or `cargo`); a second vulnerability scanner in the weekly
job; a second toolchain pinned in `mise` and in the installer's build path; contributors who must read a third
language; and, for Rust specifically, a C cross toolchain or zig, plus a macOS runner. **The marginal cost of
Go and Rust as the third language is similar in CI shape; the difference is how much each one needs beyond it.**

## 5. Recommendation, and what would change it

**Keep D15: Go, static (`CGO_ENABLED=0`), thin client, official MCP SDK.** Amend its evidence (the three
corrections in section 0) when the owner next edits that document, and add two release-job checks: the binary is
not dynamically linked (`file` or `ldd` fails the job), and `govulncheck` is run with the module-level finding in
mind (bump `x/sys`).

I considered "split" (Rust for something) and found no component that earns it; I considered "change to Rust"
and the CLI-only win is real but unspendable.

**What would change my mind:**

1. **The binary is shipped inside every image or to constrained devices** and 9 MB times the number of
   architectures starts to matter, or a size budget below about 5 MB is set.
2. **`bothy-hostd` is rewritten as a long-running static daemon** to escape Python's 21 MiB floor under a tight
   mini budget. Then Rust (4 MB RSS here) against Go (12 MB) is a fresh measurement on the real workload, and
   Rust's win on memory would be a real, not marginal, argument.
3. **`rmcp` goes six months without a breaking release** and zig-based cross builds plus a macOS runner are
   already needed for another reason.
4. **The Go MCP SDK drops the spec** or loses its maintainers (it is the official repository, with a release about two months old).
5. **Windows MSI becomes a first-class deliverable** and GoReleaser Pro is not acceptable: cargo-dist's free MSI
   is then a real point in Rust's favour (or `wix` by hand in Go's).

## 6. What I could not measure

- **Cross-machine reproducibility** for either language; only one machine and one toolchain each.
- **macOS builds**: no SDK and no Mac here. Go cross-built a darwin binary, but it was not run.
- **Windows and arm64 binaries were not executed**; only built.
- **Cold start on a Windows or macOS client** (antivirus, Gatekeeper) and on a 1 GB mini host: this box is not
  that machine. Absolute times here are noisy; read the ratios.
- **Rust with a size-tuned profile and a thin-LTO dev-friendly profile for incremental release builds**: only fat
  LTO was timed for release, so the 59 s is the worst case, not a floor.
- **The real section 6 first slice** (eight operations against the real catalog); the prototype is two endpoints.
- **Maintainer-hours** over years, which is the real deciding variable and cannot be benchmarked; the argument
  above is judgement.
- **GoReleaser Pro pricing**, **cargo-dist's winget support** beyond its documented installer list, and any
  rationale statements from the peer projects: not verified.

## 7. Sources

- Go SDK releases: <https://github.com/modelcontextprotocol/go-sdk/releases> (v1.7.0 2026-07-28, v1.8.0 2026-09-14)
- Rust SDK releases: <https://github.com/modelcontextprotocol/rust-sdk/releases> (rmcp 3.0.0 2026-07-28 to 3.10.0
  2026-11-12; the 3.0.0 notes list the breaking changes; the "reject requests to 2026-07-28 clients" entry is 3.6.0)
- MCP 2026-07-28 key changes: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- cargo-dist installers (homebrew, msi, npm, shell, powershell): <https://github.com/axodotdev/cargo-dist>
- GoReleaser (nfpm, msi marked Pro, winget, scoop, homebrew, attestations, sbom, notarize):
  <https://github.com/goreleaser/goreleaser> under `www/content/customization`
- `cross` last release v0.2.5: <https://github.com/cross-rs/cross/releases>; `cargo-zigbuild` v0.24.1:
  <https://github.com/rust-cross/cargo-zigbuild>
- Repository language data via the GitHub API, 2026-11-16: docker/compose, tilt-dev/tilt, superfly/flyctl,
  siderolabs/talos, k3s-io/k3s, hashicorp/nomad, cli/cli, astral-sh/uv, astral-sh/ruff, BurntSushi/ripgrep,
  zellij-org/zellij, casey/just
- In-repo: `cli-and-control-plane.md` sections 1.3, 2.1, 2.2, 6; `footprint-and-budgets.md`;
  `resource-management.md`; `.github/dependabot.yml`
