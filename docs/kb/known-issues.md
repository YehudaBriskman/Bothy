# Known issues & open items

_Status as of 2026-08-12 (name layer deleted). Things that look broken but aren't →
bottom section._

## Leftovers from the 2026-08-12 name-layer deletion

Both were found during the change and **deliberately not fixed**. Recorded so the
next session does not mistake them for evidence that names still work.

| Leftover | Detail | Why it was left |
|---|---|---|
| **`edge/dynamic/tals.yml` regenerates `*.tals.dev.test` routers** | `~/projects/army/Tals/manifests/scripts/preflight-ports.sh` rewrites that file on **every run**, and also sets Tals' own `VITE_FRONTEND_URL` / `BETTER_AUTH_URL` to `http://tals.dev.test`. Both have been broken since 2026-08-08, independently of Traefik. | Fixing it means editing a **private project repo** and changing how Tals addresses itself - out of scope for an infra change. The stale routers reappear after any `tilt up` in that repo. They are **inert**, but they teach the wrong pattern; do not copy them. |
| **`auth/compose.yml` still carries `Host(auth.dev.test)`** | oauth2-proxy keeps that router label and a redirect URL pinned to the dead name. The container is **not running**. | It is **being replaced by Keycloak right now** in a separate change. Do not document it as final, and do not "fix" the label - the whole service is in flight. |

## Open - worth fixing

| Item | Detail | Impact |
|---|---|---|
| **Traefik dashboard is gone** | Removed 2026-08-12 with the router that leaked a Prometheus credential ([lessons.md](lessons.md)). `--api=true` stays on because the portal's `/-/api/traefik/*` routes need `api@internal`. | Only functional loss of the change. Route data still readable at `http://100.117.176.85/-/api/traefik/http/routers`, and the portal's Routes page renders it |
| **`/-/api/traefik/*` is unauthenticated** | Read-only and carries no credentials **now** - but the 08-12 leak happened because a *later* middleware put a secret into config that a read-only endpoint would echo. | Any future `customRequestHeaders` middleware must be checked against what this surface renders |
| **SSO parked; portal API auth-free** | Dashboards got native logins on 2026-08-08 (unified dev login, see access.md), but the portal `/-/api/*` (container list, loki queries, prom queries, traefik routes) remains auth-free for any tailnet member | Accepted while tailnet = own devices. Keycloak is being introduced separately as the SSO replacement |
| **Tailscale SSH check-mode stalls automation** | ACL SSH rule gained `action: check` sometime after 08-02; unattended sessions can hang on a browser prompt | Flip to `accept` in the admin console, or live with it |
| **Wiki.js stack is down** | Replaced by Bothy Files; compose still has port 3001 | Decide: retire wiki fully or bring back |
| **Large-packet blackhole can recur** | Root cause (WinNAT hairpin wedge) not fixed, only reset by tailscaled restart; checker + runbooks now detect it | Watch for "code ok, bytes 0" |
| **ThinkPad has no sshd running** | Confirmed 2026-08-02 (dev node got connection-refused at 13:19) | Can't SSH *to* the laptop; enable if wanted; also re-verify pure-IP URLs from it when it's back online |
| **WSLg crash-loop on the dev box** | weston `rdp-backend.so` segfaults ~every 2 min (170+ since boot). Harmless to services; spams dmesg | Fix: `[wsl2] guiApplications=false` in `C:\Users\devssh\.wslconfig`, restart the distro |
| **Unattended tailscale upgrades on the laptop** | The 2026-08-02 incident came from a package upgrade without daemon restart | After any tailscale upgrade: restart tailscaled; heed the version-skew warning |
| Prometheus `rule_files` never declared | `./rules` is mounted but unused - dead config that looks live | Alerts defined there do nothing |
| Backups stay on the same disk they protect | Nothing copies them off the box | A disk loss takes data + backups |
| Portainer has RW docker socket + own auth only | Undoes the socket-proxy design from inside the tailnet (audit finding #7; Phase 2.1 decision still pending) | Anyone on the tailnet + Portainer password = root on the box |
| Host config partially outside git | dnsmasq/daemon.json/wsl.conf copies are in `host/`, keepalive + portproxy task XMLs in `host/windows/`, but nothing replays them automatically | Rebuild requires this KB |

## Fixed (kept for history)

- **Traefik dashboard served `api@internal` unauthenticated, leaking a Prometheus
  `Authorization: Basic` header via `/api/rawdata`** - fixed 2026-08-12: router
  deleted, `--api.dashboard=true` → `--api=true`. Full lesson in
  [lessons.md](lessons.md).
- **Traefik exports no metrics / no scrape job** - stale entry, removed
  2026-08-12: Traefik has exported Prometheus metrics on the internal `:8899`
  entrypoint since 2026-07 (`--metrics.prometheus=true`, router
  `prometheus@internal`), and Prometheus scrapes it by name over `devnet`.
- **Grafana `admin/admin` + auth-free dashboards** - fixed 2026-08-08: the unified
  dev login (access.md) now guards Grafana, Portainer, Dozzle, Kafka-UI, Prometheus.
- **Portproxy rules stranded by WSL IP rotation** - fixed 2026-08-08: the
  `DevBox-Portproxy-Refresh` SYSTEM task converges them at boot + every 15 min,
  and re-bound listeners to `127.0.0.1` + `100.93.197.10` (LAN exposure ended).
- **dnsmasq `log-queries` left on** - fixed 2026-08-08 (`zz-debug.conf` emptied).
- **Postboot checker stale LAN IP + elevation false-FAIL** - fixed 2026-08-02:
  `dev-box-postboot-check.ps1` now probes the stable tailnet IP `100.117.176.85`
  instead of the hard-coded DHCP address, and reports "not elevated" instead of
  `TASK MISSING` when it cannot read the keepalive task.

## Deliberate tradeoffs (don't "fix")

- dnsmasq keeps answering `address=/test/` even though nothing consumes it off-box -
  it is the box's own resolver and the `.test` entry is harmless. **Do not disable
  dnsmasq**, and do not read a successful on-box `getent hosts dev.test` as proof
  that names work (2026-08-12).
- dnsmasq answers non-`.test` queries for tailnet clients (open resolver, tailnet-scoped) -
  side effect of the upstream config that fixed in-box DNS.
- oauth2-proxy container has no healthcheck (distroless image - a check can never pass).
- Portal-API routers have no `Host()` rule. Since 2026-08-12 that is not a tradeoff,
  it is **the only supported routing shape** - see [architecture.md](architecture.md).
- prio-1 `portal-next-fallback` catches every unrouted request (that's its job) - which
  is exactly why a 200 from `:80` proves nothing; see the lookalikes list.

## Looks broken, isn't

Collected in [runbook-cant-reach.md](runbook-cant-reach.md) Step 3 - 401s, Invoke-WebRequest,
Chrome DoH, fallback-200s, hairpin SSH hangs, non-elevated "TASK MISSING".
