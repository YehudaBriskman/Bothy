# Restore manifest — 20260817T120030Z

Everything here was moved, not deleted. To undo, from /home/devssh/stacks:

```sh
mv .cleanup-trash/20260817T120030Z/apps/portal-next/html apps/portal-next/html
mv .cleanup-trash/20260817T120030Z/monitoring/dashboards/kafka.json monitoring/dashboards/kafka.json
mv .cleanup-trash/20260817T120030Z/monitoring/dashboards/redis.json monitoring/dashboards/redis.json
```

## Why each was removed

- `apps/portal-next/html/` — empty directory, root-owned, a leftover bind-mount
  artifact from a `./html:` mount the compose file no longer has. Never in git.
- `monitoring/dashboards/kafka.json`, `redis.json` — Grafana still provisioned
  dashboards for services retired on 2026-08-12. They rendered empty panels
  against datasources with no matching series.

The TypeScript removals in the same change are in git, not here: `git revert`
is their undo.
