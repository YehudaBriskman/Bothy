# Cleanup report — 2026-08-17T12:02Z

Scope: `~/stacks`. Four phases: discover, summarize, **independent review**, execute.
Two reviewing agents did none of the discovery and checked every claim themselves.

## Removed

| item | verdict | where it went |
|---|---|---|
| `ghcr.io/requarks/wiki:2` (1 GB) | APPROVE | deleted - re-pullable, no container referenced it |
| `apps/portal-next/html/` | APPROVE | quarantined - empty, root-owned bind-mount leftover |
| `monitoring/dashboards/kafka.json` | APPROVE | quarantined - provisioned for a service retired in August |
| `monitoring/dashboards/redis.json` | APPROVE | quarantined - same |
| `dataOnlySystems`, `fmtAgo` | APPROVE | git (`lib/systems.ts`) |
| `isJsonParseable` | APPROVE | git (`JsonView.tsx`) |
| `qContainerCpu`, `qContainerMem` | APPROVE | git (`lib/metrics.ts`) - superseded by the `qAllContainer*` pair |
| `STATUS_ICON_ALT` | APPROVE | git (`lib/icons.tsx`), with the `CircleDot` import it alone justified |
| `DialogTrigger` | APPROVE | git - it could not work: this Dialog is controlled-only and owns `RD.Root` |
| `System.hasRunning` | collateral | its only reader was `dataOnlySystems` |
| `/apps/docs` in dependabot | stale | the directory was deleted earlier today |

## Kept, against the proposal

| item | why |
|---|---|
| `apps/wiki/` | the only recipe that consumes a live `wiki` DB (6 pages); `just urls` advertises it as a working restore path |
| `data/kafka/`, `data/redis/` | ~8 KB whose retention is a documented decision in five places; deleting strands 10+ references |
| `DialogClose` | it *does* work here, and both consumers hand-roll it - a refactor away from use, not dead |
| `LIVE_PATHS` | referenced twice in `checks/`, which the first scan did not cover |
| `promQuote` | `SystemDialog` uses it; it survives the `qContainer*` removal |

## Found while looking, worth more than the cleanup

- **Two source files contained raw NUL bytes** (`CodeSurface.tsx`, `metrics.ts`), used as
  separators in cache-key strings. A raw NUL makes ripgrep treat a file as binary and skip
  it **silently**, so 300+ lines of the editor were invisible to every code search in this
  repo - which is why the first two dead-code scans returned nonsense. Replaced with the
  `\0` escape: identical to JavaScript, and the file stays text.
- **Two `fmtBytes` implementations** exist (`lib/systems.ts`, `lib/files.ts`). Both have live
  callers so neither reads as unused, but the `files.ts` copy lacks the defence against
  Docker reporting `Size: -1`. Follow-up, not this change.

## Restore

Quarantined files are under `.cleanup-trash/<timestamp>/` with a `RESTORE.md` holding one
`mv` per item. Code removals are in git. Empty the trash when satisfied.
