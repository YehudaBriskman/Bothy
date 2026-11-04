# CI optimisation - Bothy

Audited revision: `main` at `f726883a5430afc2598d7310ec3c60b30d3056e6`, 2026-11-02.
This file is the Bothy part of a four-repository CI plan (portfolio_site, WindoM,
Bothy, oci-free). It records what CI does today, what was measured, what is being
changed and why, and what was deliberately **not** changed.

Bothy is a **public** repository: GitHub-hosted standard-runner minutes cost
nothing here. Nothing below claims a billing saving. The goals are faster PR
feedback, no unvalidated `main` commits, and a release that is tied to evidence
about the exact commit it tags.

## Inventory

| Workflow | Triggers | Jobs | What it proves |
|---|---|---|---|
| `ci.yml` | push `main`, PR | `tree`, `mutants-plan`, `mutants-shard` ×0-4 (×4 on `main`), `mutants`, `compose`, `portal`, `images` | the tree's ~600 offline assertions; every check can fail (mutation table); compose resolves; SPA typechecks and builds, CSP hash; every Dockerfile builds |
| `install.yml` | push `main`, PR, `workflow_call(dir)` | `install`, `e2e-plan`, `e2e` ×3 (push and PR; inline on `workflow_call`), `installer` | clone into an empty directory, `just up`, every suite against the live stack, idempotence, `down` leaves nothing; `curl \| sh` installer clones, verifies, stays inside `$HOME` |
| `upgrade.yml` | nightly 04:00 UTC, dispatch | `upgrade` | install `HEAD^1`, upgrade to `HEAD`: data survives, no volume recreated, second `up` recreates nothing, images and served bundle are HEAD's, backup covers every database, every restore recipe puts data back |
| `elsewhere.yml` | nightly 03:00 UTC, dispatch | `install.yml` × {space, deep, `/tmp/bothy` control} | path portability |
| `release.yml` | `workflow_run` of CI on `main` | `tag` | tags `v$VERSION` and publishes a release when CI succeeded and the version is untagged |
| `secret-scan.yml` | push `main`, PR, weekly, dispatch | `gitleaks` | full-history secret scan (`fetch-depth: 0`) on every event |

Required status checks on `main` (branch protection, not rulesets; no merge
queue): `Checks that need nothing running`, `Every check must be able to fail`,
`Compose files parse`, `Portal typecheck and build`, `gitleaks`. Install,
images, upgrade and elsewhere are **not** required.

## Measured baseline (2026-11-02, last 40 runs per workflow)

| Workflow / event | Result | n | mean wall-clock | max |
|---|---|---|---|---|
| CI / pull_request | success | 22 | 20.9 min | 31.1 min |
| CI / push main | **cancelled** | 9 | 2.5 min | 5.1 min |
| CI / push main | success | 2 | 7.3 min | 7.3 min |
| Install / pull_request | success | 23 | 33.4 min | 43.2 min |
| Install / push main | **cancelled** | 9 | 3.1 min | 9.7 min |
| Upgrade / schedule | success | 40 | 7.3 min | 8.8 min |
| Elsewhere / schedule | **failure** | 40 | 28.6 min | 35.2 min |

Per-job timings of six PR CI runs: the critical path is a mutants shard
(4-7 min of compute). The `images`, `compose` and `portal` jobs run for 6-60
seconds each, but **started 4-25 minutes after the run was created**. PR
wall-clock is set by queueing against the account's concurrent-job limit
(Dependabot opens ~10 PRs at once; each asked for 14 jobs), not by compute.

Change mix of the last 150 first-parent commits on `main`: 93 runtime/mixed,
30 CI-only, 17 portal(+docs), **10 docs-only**.

## Findings

1. **Merged commits were not validated.** `ci.yml`, `install.yml` and
   `secret-scan.yml` used `group: <name>-${{ github.ref }}` with
   `cancel-in-progress: true` for every event. Merges landing close together
   cancelled each other: 9 of 11 recent CI push runs on `main` were cancelled.
   `release.yml` acts only on `success`, so a release-bearing merge whose run
   was cancelled was not tagged until some later commit's run happened to finish.
2. **Release is not joined to install or upgrade evidence.** `release.yml`
   triggers on CI alone. Install runs on the same push but is not waited for;
   upgrade runs only nightly. A commit can be tagged with its install failing.
3. **Upgrade covers `HEAD^1 -> HEAD` only**, never "the last release a user is
   actually running -> this candidate".
4. **Elsewhere has been red 40 nights out of 40.** Nearly always the
   space-in-path row, in the ops tier: `e2e_pgmajor.py` wrote an unquoted
   absolute path into its throwaway justfile. A test bug, not a product bug
   (fixed in B0). A second, intermittent failure - the editor tier, on all
   three paths including the control - is not path-related and is tracked
   separately.
5. **Elsewhere repeats work that does not depend on the path.** The `installer`
   job ignores `inputs.dir` by design, and runs three times a night. The
   `/tmp/bothy` control row is the same install that already runs on every
   push to `main` (once that run stops being cancelled - finding 1).
6. **Upgrade uploads failure logs unredacted.** `install.yml` redacts every
   `.env` value from its log artifact and refuses to upload if one survives;
   `upgrade.yml` uploads compose logs from a stack with real generated
   secrets, and this repository is public.

## Deliberate departures from the cross-repo audit

- **No path-based job selection in Bothy (yet).** *Narrowed by B4:* a PR
  now runs only the mutation rows its diff can reach, and a documentation-only
  PR skips the updater's end-to-end suites, which read no document. Everything
  below still holds for every other job. The plan's B1 proposes
  conservative change classification. Here, docs are *test inputs*: `tree`
  checks doc links, router-gate and cluster-action counts, diagram hashes and
  installer pins; the install suites assert served documentation headings.
  Docs-only commits are 7% of `main`. A classifier would save little and its
  only safe skip set (docs-only -> skip `images`/`portal`/`compose`) is the
  set that already costs under a minute of compute. Revisit only if the change
  mix shifts.
- **Mutant shard count unchanged.** Shards were split on 2026-10-20 to fit a
  10-minute bound; the measured shard times (4-7 min) say the bound is right.
  Benchmark before changing. *B4:* still four on `main`; a PR's count is sized
  from the rows it selects (0-4).
- **Action pins stay on major tags in these PRs.** Pinning to full commit SHAs
  touches every workflow and is its own reviewable change; Dependabot's
  `github-actions` ecosystem is already configured to maintain SHA pins once
  they exist. Proposed as a follow-up.

## PR sequence

| ID | Branch | Purpose | Status |
|---|---|---|---|
| B0 | `Claude-Bot/Fix/quote-guard-path-in-pgmajor-e2e` | quote the path the pgmajor e2e writes into a justfile; Elsewhere can go green | merged (#296) |
| B1 | `Claude-Bot/Chore/ci-keeps-every-main-run-and-queues-fewer-jobs` | cancel stale PR runs only; never cancel a push to `main`; one `images` job instead of three; gitleaks timeout; this document | merged (#297) |
| B2 | `Claude-Bot/Fix/release-waits-for-install-and-upgrade` (stacked on B1) | release waits for CI **and** Install **and** Upgrade on the exact SHA; upgrade also runs on push to `main`; add last-release -> candidate upgrade; keep `HEAD^1` | merged (#298) |
| B3 | `Claude-Bot/Fix/ci-logs-redacted-everywhere-and-elsewhere-runs-only-the-paths` (stacked on B2) | one redaction script for install and upgrade whose refusal actually holds; Elsewhere stops re-running the path-independent installer job | merged (#299) |
| B4 | `Claude-Bot/Chore/ci-runs-what-a-change-can-affect` | the updater's e2e suites run as three parallel jobs beside the install, not inside it; a PR runs only the mutation rows it can reach; docs-only PRs skip the e2e suites | this branch |

### B1 - what changes and what does not

- Concurrency: `group` is the ref for PRs and the SHA otherwise;
  `cancel-in-progress` is true only for `pull_request`. A pending run in a
  shared group is dropped by GitHub even with `cancel-in-progress: false`,
  which is why pushes need their own group rather than just "don't cancel".
  Affects `ci.yml`, `install.yml` (including the `workflow_call` used by
  Elsewhere, where the event is `schedule` and nothing is cancelled) and
  `secret-scan.yml`.
- `images` becomes one job with one named step per image, each `if: always()`,
  same cache scopes. Jobs per PR: 14 -> 12. Same three builds.
- `gitleaks` gains `timeout-minutes: 10` (measured runs: 11-17 s; default 360).
- **Unchanged:** every check, every suite, every assertion; the required
  check names; `release.yml` and `upgrade.yml` concurrency.

### B2 - what changes and what does not

- `release.yml` triggers on the completion of CI, Install **or** Upgrade on
  `main`. When `VERSION` is untagged it reads the newest push run of all three
  for the exact head SHA and asks `scripts/release-decision.sh`:
  `release` tags; `wait` is a green no-op (the last to finish decides);
  `block` is a red run naming the failed prerequisite. Only
  `completed`+`success` counts - skipped, cancelled, neutral, timed-out and
  unknown states block. Concurrency is per SHA. Two commits racing for one
  `VERSION` are arbitrated by the tag push and the loser says which commit
  owns the tag.
- The rule is a truth table (`scripts/checks/release-decision.sh`, 18 rows,
  run in `tree`) and `mutants.sh` gains four rows proving the table catches
  "skipped counts as success", "a failure hides behind a running workflow",
  "a required workflow nobody asked about" and "an unknown status passes".
- `upgrade.yml` runs on push to `main` (never cancelled, keyed by SHA) as well
  as nightly, with two rows: `previous` (`HEAD^1`, unchanged) and `release`
  (newest `v*` tag reachable from `HEAD^1`; no tag is a failure, not a skip).
  Every assertion - data, volume identity, idempotence, HEAD's images and
  bundle, backup coverage, damage-and-restore - runs on both rows.
- **Recovery:** re-run the failed prerequisite; its completion re-triggers the
  release. No dispatch input and no manual tag.
- **Unchanged:** CI and Install themselves; the installer-pin follow-up PR.
- **Risk to watch:** the `release` row installs a release from up to months
  ago on today's runner image. If an old release cannot install on a runner
  for reasons unrelated to upgrading, that row is red and blocks releases
  until a newer release exists or the row is adjusted - deliberately loud.

### B3 - what changes and what does not

- **Defect found while doing this:** install.yml's redaction printed
  "REFUSING to upload" and exited 1 inside a step running under `set +e`
  whose last command was an `echo`. The step passed and the `if: failure()`
  upload ran - the refusal never held. Redaction is now
  `scripts/redact-logs.py`, which **empties the log directory** (leaving only
  a `REFUSED.txt` naming keys, never values) whenever it cannot prove every
  generated secret is gone. Verification is on bytes.
- `upgrade.yml` uploaded its failure logs unredacted; it now runs the same
  script.
- Table test `scripts/checks/redact-logs.sh` (9 rows, in `tree`) and four
  mutants rows: a refusal that leaves logs in place, a verification that never
  runs, shortest-first replacement, a key list read from a comment.
- `install.yml` gains a `workflow_call` input `installer` (default true);
  Elsewhere passes `false`. The `installer` job ignores `dir` and already runs
  on every PR and push - three nightly copies tested nothing new. The
  condition is `toJSON(inputs.installer) != 'false'`, because expressions
  compare loosely and `null != false` is **false**: the obvious spelling
  would have skipped the job on every PR.
- **Departure from the audit: the control row stays.** The audit proposed
  dropping Elsewhere's `/tmp/bothy` row as covered by the push-time install.
  It is not: that ran on the day of the merge, and Upgrade's nightly install
  does not run the ops and editor suites, where the failures are. The control
  row is what showed the intermittent editor-tier failure is not path-related.

### B4 - what was wrong (measured 2026-11-04)

Job and step timings of the last 6 CI and 5 Install PR runs, and 13 of each on
`main` (`gh run view --json jobs`):

| | median | max |
|---|---|---|
| Install / PR, wall-clock | 26.4 min | 31.0 min |
| ...its ops step alone | 20.5 min | 21.5 min |
| CI / PR, wall-clock | 7.5 min | 7.7 min |
| ...each of the four mutants shards | 6.6-7.2 min | 7.8 min |
| CI / PR, job-minutes | 29.2 | |

1. **The install job waited 20 minutes for suites that do not need it.** The
   ops step runs `e2e_updater`, `e2e_config`, `e2e_auto`, `e2e_update_alerts`,
   `e2e_owncode`, `e2e_pgmajor` and `e2e_cluster` one after another. Each
   builds and removes its own throwaway compose project, registry and git
   repository; none reads the stack `just up` started. Every PR's wall-clock
   was this one step.
2. **Every PR ran all ~250 mutation rows**, ~27 runner-minutes on four
   runners, whatever it touched. Of the last 30 merged PRs, 12 can reach at
   most four rows (a Traefik or Keycloak pin, a doc), and 8 change something
   every row depends on (mutants.sh, ci.yml, the shared check library).

### B4 - what changes and what does not

- **The e2e suites are groups in `apps/bothy-ops/checks/run.sh`**
  (`updater`, `config-and-night`, `own-code-and-majors`, balanced on the
  measured times) with `--no-e2e`, `--e2e=<group>` and `--list-e2e-groups`.
  No flag still runs everything, so `just ops-check` is unchanged.
- **`install.yml` runs one job per group** (`Updater end to end - <group>`),
  in parallel with the install. The matrix is read from
  `--list-e2e-groups`, so a new suite cannot be missing from CI. The install
  job's ops step runs `--no-e2e` (transition.py still runs against the real
  daemon there); its timeout drops from 45 to 20 minutes.
  - A suite whose prerequisites are missing prints `SKIP:` and exits 0. In the
    install job none skipped; in the new jobs a `SKIP:` line fails the job, so
    a runner that lost `just` or the systemd user manager cannot pass as green.
  - `workflow_call` callers (elsewhere.yml) get a new input `inline_e2e`,
    default true: the nightly awkward-path rows still run the suites inside the
    install, from the awkward path, exactly as before.
- **`ci.yml` gains `mutants-plan`.** On a PR it lists the merge commit's diff
  against its first parent (`scripts/ci-changes.sh files`) and has
  `mutants.sh` count the rows that diff can reach, without planting anything
  (`MUTANTS_COUNT=1`). The shard matrix is sized from the estimate: none, one
  shard per ~4 minutes of work, at most four. A row runs when its mutated file
  or its check's script changed, or anything in the app whose harness the
  check is; mutants.sh, `scripts/ci-changes.sh`, ci.yml, `scripts/lib/` and
  `apps/bothy-common/` run every row.
- **The required check `Every check must be able to fail` keeps its name.** It
  is green when every shard is, or when the plan succeeded and counted zero
  rows - and red when the plan failed, since that skips the shards too.
- **A docs-only PR skips the e2e jobs** (`docs/`, `*.md` outside `apps/`,
  issue templates, CODEOWNERS). It still runs the install, for the reason in
  "Deliberate departures".
- **`main` is unchanged in coverage**: every row on four shards and every e2e
  group, on every push. `release.yml` and `scripts/release-decision.sh` are
  untouched; a workflow run whose jobs were split still concludes `success`
  only when every job did.
- **The rule is a table**: `scripts/checks/ci-changes.sh` (24 rows, in
  `tree`), and six mutants rows prove it bites.

## Required-check migration map

| Check name | Before | After B1 | After B2 | After B4 |
|---|---|---|---|---|
| `Checks that need nothing running` | required | unchanged | unchanged | unchanged |
| `Every check must be able to fail` | required | unchanged | unchanged | unchanged; also green when a PR reaches no row |
| `Compose files parse` | required | unchanged | unchanged | unchanged |
| `Portal typecheck and build` | required | unchanged | unchanged | unchanged |
| `gitleaks` | required | unchanged | unchanged | unchanged |
| `Every image builds (bothy-web)` etc. | not required | replaced by `Every image builds` | - | - |
| `Clone it, start it, run every suite against it` | not required | unchanged | gates the release (in `release.yml`, not branch protection) | unchanged |
| `Mutants k/4` | not required | unchanged | unchanged | unchanged name; a shard above the planned count completes green in seconds |
| `Updater end to end - <group>` | - | - | - | new, not required; gates the release through Install's conclusion |

No branch-protection change is needed for B1 or B4. Making `Every image builds` or
the install job *required* for merge is a separate decision for the owner: it
would put a 30-minute job on every Dependabot PR's merge path.

## Verification done locally

- `actionlint` 1.7.12 with shellcheck 0.11.0 over all workflows: the same 24
  pre-existing findings before and after (all inside embedded scripts, none
  introduced). A parser passing is not proof that the concurrency expression
  behaves as intended; that is confirmed only by the first PR push (stale run
  cancelled) and the first two quick merges (both `main` runs complete).

## How to measure after rollout

Re-run the baseline query (`gh run list -w <file> -L 40 --json
event,conclusion,createdAt,updatedAt`) after two weeks of normal traffic.
Expected: zero `cancelled` push runs on `main`; PR wall-clock compared at the
median and the slowest run, not as a percentage target - the sample is small
and Dependabot bursts dominate it.
