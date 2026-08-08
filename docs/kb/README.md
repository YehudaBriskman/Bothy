# dev-box knowledge base

Everything known about the dev stack ("stack system dev", repo `YehudaBriskman/dev-box`)
and the machines around it. Built 2026-08-02 from the July audit + the August incidents.

> **Something is broken RIGHT NOW?** → open **[runbook-cant-reach.md](runbook-cant-reach.md)**
> and follow the decision tree. Do not start debugging the box before step 0.

## Map

| File | What's in it |
|---|---|
| [topology.md](topology.md) | Every machine, user, IP, tailnet node, WSL instance, and how they connect |
| [access.md](access.md) | Every way into the box: SSH paths, usernames, elevation tricks, visibility gotchas |
| [dns.md](dns.md) | **RETIRED 2026-08-08** — access is pure IP:port now; this file is the DNS re-enable manual |
| [always-on.md](always-on.md) | Why the box stays up unattended: keepalive task, ForceDaemon, cold-boot proof |
| [architecture.md](architecture.md) | What runs inside: Traefik, SSO, portal, backups, monitoring — and the built-in traps |
| [runbook-cant-reach.md](runbook-cant-reach.md) | **The** diagnosis decision tree for "can't reach the dev stack" |
| [runbook-post-reboot.md](runbook-post-reboot.md) | What to do after the Windows host reboots |
| [known-issues.md](known-issues.md) | Open items, deliberate tradeoffs, and things that look broken but aren't |
| [lessons.md](lessons.md) | Debugging principles paid for in blood, incl. every wrong conclusion we corrected |
| [incidents/2026-07-21-wsl-idle-timeout.md](incidents/2026-07-21-wsl-idle-timeout.md) | "Only works while SSH'd in" — WSL VM 60s idle kill |
| [incidents/2026-08-01-ethernet-ndis.md](incidents/2026-08-01-ethernet-ndis.md) | Host NIC/NDIS pause-wedge, DHCP death, LAN IP change |
| [incidents/2026-08-02-thinkpad-tailscale.md](incidents/2026-08-02-thinkpad-tailscale.md) | Laptop's half-upgraded tailscaled: tunnel green, all traffic dead |
| [incidents/2026-08-08-wsl-node-large-packet-blackhole.md](incidents/2026-08-08-wsl-node-large-packet-blackhole.md) | Pings pong but bodies stall / SSH hangs at KEX; small-KEX door; restart tailscaled on the box |

## Source documents (kept, not superseded for detail)

- `C:\Users\yr055\dev-box-audit.md` — the full July audit: 25 findings, 14 PRs, all corrections
- `C:\Users\yr055\dev-box-reboot-note.md` — original post-reboot instructions
- `C:\Users\yr055\thinkpad-tailscale-incident-2026-08-02.md` — full Aug 2 incident report
- `C:\Users\yr055\ts-log-copy\` — host tailscaled log copies from the Aug 2 investigation
- `C:\Users\yr055\dev-box-postboot-check.ps1` / `-report.txt` — the post-boot checker and its last run

## Keeping this useful

After any incident or infra change: update the relevant topic file, add/append an
incident file, and add one line to [lessons.md](lessons.md) if a new principle emerged.
Stale knowledge caused real damage twice (stale repo → wrong audit findings; stale
checker IP → false FAIL). Dates on claims matter — keep them.
