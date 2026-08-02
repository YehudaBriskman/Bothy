# Incident 2026-07-21 — "the box only works while I'm SSH'd in"

**Status: RESOLVED** (fix proven across a cold boot on 2026-08-01).

## Symptom
The dev stack worked during SSH sessions and died shortly after disconnecting. Looked like
crashing services / flaky Traefik; weeks of intermittent "the site is down".

## Root cause
WSL2 destroys its utility VM **60 seconds after the last Windows-side client disconnects**
(no `vmIdleTimeout` in devssh's `.wslconfig`). An SSH session was the only client holding
it open — disconnect → 60s → VM gone, taking docker, ~25 containers and the in-WSL
Tailscale node. Confirmed by kernel boot lines repeating every ~80s, once per probe.

Contributing: the Windows host's Tailscale lacked unattended mode (`ForceDaemon`), so the
host node also dropped when devssh's session ended.

## Fix
`DevBox-WSL-Keepalive` scheduled task (runs as devssh at boot + logon, holds
`wsl … sleep infinity` forever) + `ForceDaemon: true` on the host + `tailscale set
--ssh=true` in the distro. Full detail: [../always-on.md](../always-on.md).

## What made it hard
- The repo didn't describe reality (README still sold an SSH-tunnel model); auditing
  `origin/main` produced wrong findings. → [../lessons.md](../lessons.md) #8.
- Same audit surfaced 25 findings (empty backups, unpersisted Kafka, uncommitted working
  system, SSO absence…) fixed across PRs #1–#14. Full record: `C:\Users\yr055\dev-box-audit.md`.
