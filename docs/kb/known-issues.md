# Known issues & open items

_Status as of 2026-08-08 (pure-IP switch). Things that look broken but aren't → bottom section._

## Open — worth fixing

| Item | Detail | Impact |
|---|---|---|
| **SSO is dormant, more surface on the tailnet** | Since 2026-08-08: dozzle, kafka-ui, prometheus, the portal `/-/api/*` are auth-free for any tailnet member; Portainer's RW docker socket is now the sharpest edge | Accepted while tailnet = own devices; revisit with the future DNS/WireGuard phase |
| **Tailscale SSH check-mode stalls automation** | ACL SSH rule gained `action: check` sometime after 08-02; unattended sessions can hang on a browser prompt | Flip to `accept` in the admin console, or live with it |
| **Wiki.js stack is down** | Replaced by Docs (:8085); compose still has port 3001 | Decide: retire wiki fully or bring back |
| **Large-packet blackhole can recur** | Root cause (WinNAT hairpin wedge) not fixed, only reset by tailscaled restart; checker + runbooks now detect it | Watch for "code ok, bytes 0" |
| **ThinkPad has no sshd running** | Confirmed 2026-08-02 (dev node got connection-refused at 13:19) | Can't SSH *to* the laptop; enable if wanted; also re-verify pure-IP URLs from it when it's back online |
| **WSLg crash-loop on the dev box** | weston `rdp-backend.so` segfaults ~every 2 min (170+ since boot). Harmless to services; spams dmesg | Fix: `[wsl2] guiApplications=false` in `C:\Users\devssh\.wslconfig`, restart the distro |
| **Unattended tailscale upgrades on the laptop** | The 2026-08-02 incident came from a package upgrade without daemon restart | After any tailscale upgrade: restart tailscaled; heed the version-skew warning |
| Prometheus `rule_files` never declared | `./rules` is mounted but unused — dead config that looks live | Alerts defined there do nothing |
| Traefik exports no metrics / no scrape job | The front door is the one unmonitored component | Blind spot |
| Backups stay on the same disk they protect | Nothing copies them off the box | A disk loss takes data + backups |
| Portainer has RW docker socket + own auth only | Undoes the socket-proxy design from inside the tailnet (audit finding #7; Phase 2.1 decision still pending) | Anyone on the tailnet + Portainer password = root on the box |
| Grafana still `admin/admin`; some services rely on SSO only | Audit Phase 2.4 | Weak on-tailnet posture |
| Host config partially outside git | dnsmasq/daemon.json/wsl.conf copies are in `host/`, keepalive + portproxy task XMLs in `host/windows/`, but nothing replays them automatically | Rebuild requires this KB |

## Fixed (kept for history)

- **Portproxy rules stranded by WSL IP rotation** — fixed 2026-08-08: the
  `DevBox-Portproxy-Refresh` SYSTEM task converges them at boot + every 15 min,
  and re-bound listeners to `127.0.0.1` + `100.93.197.10` (LAN exposure ended).
- **dnsmasq `log-queries` left on** — fixed 2026-08-08 (`zz-debug.conf` emptied).
- **Postboot checker stale LAN IP + elevation false-FAIL** — fixed 2026-08-02:
  `dev-box-postboot-check.ps1` now probes the stable tailnet IP `100.117.176.85`
  instead of the hard-coded DHCP address, and reports "not elevated" instead of
  `TASK MISSING` when it cannot read the keepalive task.

## Deliberate tradeoffs (don't "fix")

- dnsmasq answers non-`.test` queries for tailnet clients (open resolver, tailnet-scoped) —
  side effect of the upstream config that fixed in-box DNS.
- oauth2-proxy container has no healthcheck (distroless image — a check can never pass).
- Portal-API routers have no `Host()` rule (bare-IP access works; rebinding risk closed by SSO).
- prio-1 `portal-fallback` catches all unrouted hosts (that's its job; see the lookalikes list).

## Looks broken, isn't

Collected in [runbook-cant-reach.md](runbook-cant-reach.md) Step 3 — 401s, Invoke-WebRequest,
Chrome DoH, fallback-200s, hairpin SSH hangs, non-elevated "TASK MISSING".
