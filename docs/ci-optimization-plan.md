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
| `ci.yml` | push `main`, PR | `tree`, `mutants-shard` ×4, `mutants`, `compose`, `portal`, `images` | the tree's ~600 offline assertions; every check can fail (mutation table); compose resolves; SPA typechecks and builds, CSP hash; every Dockerfile builds |
| `install.yml` | push `main`, PR, `workflow_call(dir)` | `install`, `installer` | clone into an empty directory, `just up`, every suite against the live stack, idempotence, `down` leaves nothing; `curl \| sh` installer clones, verifies, stays inside `$HOME` |
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

- **No path-based job selection in Bothy (yet).** The plan's B1 proposes
  conservative change classification. Here, docs are *test inputs*: `tree`
  checks doc links, router-gate and cluster-action counts, diagram hashes and
  installer pins; the install suites assert served documentation headings.
  Docs-only commits are 7% of `main`. A classifier would save little and its
  only safe skip set (docs-only -> skip `images`/`portal`/`compose`) is the
  set that already costs under a minute of compute. Revisit only if the change
  mix shifts.
- **Mutant shard count unchanged.** Shards were split on 2026-10-20 to fit a
  10-minute bound; the measured shard times (4-7 min) say the bound is right.
  Benchmark before changing.
- **Action pins stay on major tags in these PRs.** Pinning to full commit SHAs
  touches every workflow and is its own reviewable change; Dependabot's
  `github-actions` ecosystem is already configured to maintain SHA pins once
  they exist. Proposed as a follow-up.

## PR sequence

| ID | Branch | Purpose | Status |
|---|---|---|---|
| B0 | `Claude-Bot/Fix/quote-guard-path-in-pgmajor-e2e` | quote the path the pgmajor e2e writes into a justfile; Elsewhere can go green | local commit |
| B1 | `Claude-Bot/Chore/ci-keeps-every-main-run-and-queues-fewer-jobs` | cancel stale PR runs only; never cancel a push to `main`; one `images` job instead of three; gitleaks timeout; this document | local commit |
| B2 | stacked on B1 | release waits for CI **and** Install **and** Upgrade on the exact SHA; upgrade also runs on push to `main`; add last-release -> candidate upgrade; keep `HEAD^1` | planned |
| B3 | after B1 | Elsewhere: drop the control row and stop re-running the path-independent installer job; upgrade redacts its log artifact the way install does | planned |

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

## Required-check migration map

| Check name | Before | After B1 | After B2 |
|---|---|---|---|
| `Checks that need nothing running` | required | unchanged | unchanged |
| `Every check must be able to fail` | required | unchanged | unchanged |
| `Compose files parse` | required | unchanged | unchanged |
| `Portal typecheck and build` | required | unchanged | unchanged |
| `gitleaks` | required | unchanged | unchanged |
| `Every image builds (bothy-web)` etc. | not required | replaced by `Every image builds` | - |
| `Clone it, start it, run every suite against it` | not required | unchanged | gates the release (in `release.yml`, not branch protection) |

No branch-protection change is needed for B1. Making `Every image builds` or
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
