# Two install kinds, two update paths (written 2026-11-17)

Status: design plus one small read-only slice built (below). Nothing here changes how the live box
updates. Sources read: `~/claude-notes/stack/updates.md`, `distribution-and-packaging.md` (D34),
`bothy-install.md` section 8 and 8b, `apps/bothy-ops/updates.toml`, `updater/plans.py`,
`updater/owncode.py`, `cli/internal/install/selfupdate.go`.

## 1. The rule

| | **checkout box** (the live box, `~/stacks`) | **installed box** (`bothy install`) |
|---|---|---|
| What it is | a git checkout on `main`, compose files and pins in the tree | a binary, a receipt, generated files, images pulled by digest; **no checkout** |
| Source of truth for "what to run" | what the checked-out `main` pins | the release manifest the receipt records (digests) |
| Who updates it | the web updater (`bothy-updater` host executor) after a person runs `git pull`; the night job for `auto` components | `bothy update`, run by a person |
| What "newer" means | a pin merged to `main`, pulled; for Bothy itself the newest green `v*` tag **ahead of HEAD**, on `origin/main` | the highest stable CalVer GitHub release |
| Trust | git history plus CI, `main` only | TLS to GitHub, the sha256 chain, `gh attestation verify` when present (8b) |
| Rollback | previous digest or git sha, 10-minute timer | `previous/` receipt and files, `bothy.prev` binary |

**Neither updater ever acts on the other's kind.** That is enforced structurally, not by convention:

* The web updater cannot act on an installed box. Every plan starts at `_git_gate` / `owncode.gate`, which run `git`
  in the checkout, require `symbolic-ref HEAD == main`, a clean pin file and an ancestor of `origin/main`. With no
  checkout the first `git` call fails and the plan is **refused with a reason**; nothing is queued. (Verified by
  reading `plans.py` lines 120-130 and `owncode.py` 176-198; not run against an installed box, there is none
  with bothy-ops yet.)
* `bothy update` cannot act on the live box. It needs `<root>/receipt.json`; with none it stops with "nothing is
  installed here ... run `bothy install`" before any network call or write (`SelfUpdate`, `Update`). The live box
  has no receipt. A new test pins this ordering for the `--json` flag.

## 2. How each kind is detected

One helper, `install.DetectKind(dataDir, starts...)` (cli/internal/install/kind.go), read-only, two stats and a walk up:

| Receipt at `<root>/receipt.json` | Git checkout above the binary's or working directory (`.git` **and** `apps/bothy-ops/updates.toml`) | Kind | Update path |
|---|---|---|---|
| yes | no | `installed` | `bothy update` |
| no | yes | `checkout` | web updater / `git pull` |
| yes | yes | `ambiguous` | **none**: a person decides which owns the box; neither updater should act |
| no | no | `none` | none (fresh machine, bare binary) |

Choices and their reasons: the receipt is only *stat*ed, never parsed, so a damaged receipt cannot flip the
classification (the update verb reports the damage itself). The checkout needs the repo's own `updates.toml` so
that a developer's unrelated repo above `$HOME` does not count. `.git` may be a file (worktrees). The walk is
bounded (16 levels).

The web side does not need this helper: bothy-ops already knows it is in a checkout, because it mounts `cfg.repo`
and the executor runs git there. The helper exists for the CLI and for any future reporting row.

## 3. What the web page shows, and would do, on each kind

* **Checkout box (today).** Unchanged. Settings > Updates, the "Bothy" `own-code` row (deploys only a newer `v*` tag
  that is green, on `origin/main`, ahead of HEAD), everything else only what `main` pins.
* **Installed, mode `mini`.** There is **no bothy-ops and no web updates page** (the mini stack is traefik, bothy-web,
  bothy-files). The only update path is the CLI. Nothing to show; nothing to build.
* **Installed, a mode that does ship bothy-ops (not built yet).** Today the page would load and every row would be
  refused ("not a git checkout / not on main"), which is correct and harmless but unhelpful. The designed behaviour
  is a **read-only** "Bothy release" row, fed by `bothy update --check --json` (section 5): "v2026.12.0 is available;
  run `bothy update` on the host". There is **no Update button** on an installed box in this design. Reason: the
  update replaces the binary and restarts the stack, including bothy-ops and the edge that carried the request,
  and it needs the host executor and the host-writable binary directory; the existing "never a container"
  reasoning (updates.md, "Shape") applies in full. If a button is ever wanted it is the existing spool/host-executor
  pattern calling `bothy update` as a **new request kind**, with the four-kinds checklist (`spool.OTHER_KINDS`, the
  drain loop, `checks/wiring_updates.py`) and its own review. Not now.

## 4. What the web path must never do on the live box

Restating the standing rules so the new CLI signal cannot erode them:

1. Never leave `~/stacks` off `main`; never commit to it; the updater reads `main` (live-checkout rule).
2. Never write a pin or `VERSION` itself (only a rollback writes a pin, deliberately, and that line is then read
   by a person before reverting).
3. Never offer a release `main` does not already pin/tag-ahead. A GitHub release is **not** a plan on this box:
   the release signal is information, and acting on it still means merge, `git pull`, Update. A "latest release"
   row on the checkout box must therefore be labelled as information and carry no apply control.
4. Never call `bothy update` on a checkout box (the binary would replace itself and apply a stack from a receipt
   the box does not have). `bothy update` refuses for lack of a receipt; do not "fix" that refusal.
5. Never route `/v1` at the edge for this (D40); exposure of any new operation stays `socket` (D42); no write path.

## 5. Built: the read-only release signal

```
bothy update --check --json
```

Prints one JSON document and changes nothing (no download of a release, no receipt/file write, only the GitHub
release list is read):

```json
{
  "schema": 1,
  "kind": "installed|checkout|ambiguous|none",
  "updatePath": "bothy update | web updater (git pull, then Settings > Updates) | none ...",
  "current": "2026.11.2",
  "latest": "2026.12.0", "tag": "v2026.12.0",
  "updateAvailable": true,
  "packager": "",                       // set when a package manager owns the binary
  "error": "", "errorKind": ""          // rate-limited | offline | other; omitted on success
}
```

* Works on **both kinds** and needs no receipt (unlike `update --check` in text form, which describes the apply
  plan and requires one): on the checkout box it answers "is there a newer release than the running binary",
  and `kind` says that acting on it is not `bothy update`'s job.
* Exit code 0 when answered; 1 (document still printed) when the latest release could not be determined.
* Reuses `Source.Latest` unchanged: the same strict-CalVer, no-prerelease, highest-wins discovery and the same
  trust statement (one string, the tag, from `api.github.com`; nothing here fetches any other URL).
* `--json` combined with anything other than `--check` behaves exactly as before (the flag was ignored).
* **Not built, deliberately:** an `operations.toml` entry. Putting this into the `/v1` catalog would put an
  outbound network call to GitHub behind the bothy-ops service (which has none today and is read-only on the
  host), plus rate-limit state (60/h unauthenticated, per public IP) shared with discovery. The right feed for a
  future web row is the existing 6-hourly discovery timer (`discover_updates.py`, which already asks GitHub
  releases for the `bothy` component and caches) writing one more field to `available.json`, not the browser or
  the API calling GitHub. That is a change to live updater files, which this slice was told not to touch.
  `just ops-v1 check` stays green because nothing in the catalog moved.

## 6. Open items (not decided here)

* A mode with bothy-ops plus the `kind` row (section 3): needs the discovery timer to run in that mode, or the
  CLI signal to be cached by something host-side. Decide when such a mode exists.
* `ambiguous` has no consumer yet; `bothy update` does not call `DetectKind` (a receipt alone already gates it,
  and changing the verb would change live behaviour). If it ever does, `ambiguous` should refuse.
* Unproven: the real GitHub API (only one release exists), and the helper on Windows.
