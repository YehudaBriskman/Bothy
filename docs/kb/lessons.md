# Lessons — principles paid for in real debugging time

_Each of these was learned by getting it wrong first._

## Diagnosis

1. **First question for any "dev.test is broken": is that device on the tailnet?**
   Every false alarm and the real Aug-2 incident started here. Client-side tunnel/DNS
   failure is indistinguishable from a dead box, from that client.
2. **Prove which side is broken before touching the box** — layered pings
   (`tailscale ping` → `--tsmp` → `--icmp` → real traffic) name the exact broken layer
   in under a minute ([runbook-cant-reach.md](runbook-cant-reach.md)).
3. **A green `tailscale status` does not mean traffic flows.** The daemon can be up with
   its interface unprogrammed (no IP) — internal pings pong while everything real dies.
4. **`client version != tailscaled server version` = stop and restart the daemon.**
   A half-upgraded daemon caused a full day of outage; `down/up` doesn't fix it.
5. **"Access is denied" ≠ "does not exist."** Non-elevated queries misread devssh's
   scheduled task as MISSING and the Tailscale logs as absent ([access.md](access.md)).
6. **Test with two clients before blaming the server** (PC *and* phone). One client is a
   hypothesis, two are evidence.
7. **Beware verification commands that cannot fail** — the portal-API "MUST print 404"
   check printed 404 whether the boundary held or not; the fallback answers 200 to
   anything. Verify with a probe that *can* distinguish the failure.

## Auditing / changing this system

8. **Audit the live box, never the repo.** `origin/main` ran ~a week behind and produced
   several confidently-wrong findings (no reverse proxy, crash-looping traefik, no
   auto-start — all false). Full corrections table: `dev-box-audit.md` §7.
9. **Verify audit claims before acting on them.** Three findings were disproven only by
   running the command live (Health field exists; cvops routed; docker-daemon target up).
10. **Hard-coded addresses rot.** The checker's `192.168.68.57` false-FAILed the moment
    DHCP moved the host. Prefer names; date-stamp any literal IP you must write.
11. **After `git checkout`, force-recreate containers with bind mounts** — stale-inode
    mounts made Traefik serve a 5-day-old config while claiming live-reload.
12. **`docker compose` doesn't read the root `.env`** — only `just` does.
13. **A silent success is worse than a loud failure.** Backups "succeeded" as 20-byte
    gzips for six days; the timer was green. The fix that matters was making `doctor.sh`
    check artifact **age and size**, not exit codes.
14. **Write things down where the next debugging session will look.** The Aug-2 diagnosis
    was fast *because* July's audit had recorded the topology (per-user WSL, Tailscale
    SSH, split DNS). This KB exists to keep that compounding.

## Client-side quirks (Windows)

15. `Invoke-WebRequest` times out on `.test` names — use `curl.exe`.
16. Chrome Secure DNS (DoH) can't resolve `.test` — looks like NXDOMAIN, isn't the box.
17. WSL distros are **per-user**; `wsl -l` never shows another user's distro.
