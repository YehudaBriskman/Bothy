# Lessons - principles paid for in real debugging time

_Each of these was learned by getting it wrong first._

## Diagnosis

1. **First question for any "the dev box is broken": is that device on the tailnet?**
   Every false alarm and the real Aug-2 incident started here. Client-side tunnel
   failure is indistinguishable from a dead box, from that client. (Until 2026-08-08
   the tell was a failing `dev.test` lookup; names are retired, so probe
   `http://100.117.176.85:<port>` instead.)
2. **Prove which side is broken before touching the box** - layered pings
   (`tailscale ping` → `--tsmp` → `--icmp` → real traffic) name the exact broken layer
   in under a minute ([runbook-cant-reach.md](runbook-cant-reach.md)).
3. **A green `tailscale status` does not mean traffic flows.** The daemon can be up with
   its interface unprogrammed (no IP) - internal pings pong while everything real dies.
4. **`client version != tailscaled server version` = stop and restart the daemon.**
   A half-upgraded daemon caused a full day of outage; `down/up` doesn't fix it.
5. **"Access is denied" ≠ "does not exist."** Non-elevated queries misread devssh's
   scheduled task as MISSING and the Tailscale logs as absent ([access.md](access.md)).
6. **Test with two clients before blaming the server** (PC *and* phone). One client is a
   hypothesis, two are evidence.
7. **Beware verification commands that cannot fail** - the portal-API "MUST print 404"
   check printed 404 whether the boundary held or not; the fallback answers 200 to
   anything. Verify with a probe that *can* distinguish the failure.
8. **Check bytes, not just status codes.** The Aug-8 blackhole passed every code-only
   probe (401 header arrived) while every body stalled at 0 bytes; pings pong because
   they're small. Size the hole with `ping -l <n>`, and when SSH hangs at KEX, force a
   small handshake (`-o KexAlgorithms=curve25519-sha256 -o HostKeyAlgorithms=ssh-ed25519`)
   to get in and fix it ([incidents/2026-08-08](incidents/2026-08-08-wsl-node-large-packet-blackhole.md)).

## Secrets and admin APIs

**An unauthenticated admin API that echoes your own configuration will leak any
credential you inject via a headers middleware.** Found and fixed 2026-08-12.

Traefik's `dashboard` router served `api@internal` on `Host(traefik.dev.test)`
with no middleware in front of it. That API includes **`/api/rawdata`**, which
dumps the entire merged dynamic configuration - including the
`portal-api-prom-auth` middleware, whose `customRequestHeaders` carried a live
`Authorization: Basic …` for Prometheus. Anything on the tailnet could read that
credential by fetching one URL. No exploitation was observed; the exposure window
was the life of the router.

The generalisable part, which is worth more than the fix:

- **A headers middleware hides a secret from the *browser*, not from the *config
  dump*.** "Inject the auth header at the proxy" feels like it removes the
  credential from the client, and it does - while adding it to a document the
  proxy will happily serve to anyone who can reach its API.
- **Any proxy with introspection has this shape.** Before adopting a header-
  injection pattern, ask what the proxy's own `/api/*` surface will render, and
  who can reach it.
- **Read-only is not the same as harmless.** The dashboard was correctly described
  as read-only, and the router carried a note reasoning that it "grants no
  authority that isn't already there". That reasoning was about *route* data and
  silently failed to cover *middleware* data added later.
- **The fix separates two flags that look like one.** `--api=true` must stay on
  (the portal's `/-/api/traefik/*` routes use `service: api@internal`);
  `--api.dashboard=true` is what made it browsable, and only that was removed,
  along with the router. The dashboard UI is the only functional loss.

## Auditing / changing this system

9. **Audit the live box, never the repo.** `origin/main` ran ~a week behind and produced
   several confidently-wrong findings (no reverse proxy, crash-looping traefik, no
   auto-start - all false). Full corrections table: `dev-box-audit.md` §7.
10. **Verify audit claims before acting on them.** Three findings were disproven only by
   running the command live (Health field exists; cvops routed; docker-daemon target up).
11. **Hard-coded addresses rot.** The checker's `192.168.68.57` false-FAILed the moment
    DHCP moved the host. Prefer names; date-stamp any literal IP you must write.
12. **After `git checkout`, force-recreate containers with bind mounts** - stale-inode
    mounts made Traefik serve a 5-day-old config while claiming live-reload.
13. **`docker compose` doesn't read the root `.env`** - only `just` does.
14. **A silent success is worse than a loud failure.** Backups "succeeded" as 20-byte
    gzips for six days; the timer was green. The fix that matters was making `doctor.sh`
    check artifact **age and size**, not exit codes.
15. **Write things down where the next debugging session will look.** The Aug-2 diagnosis
    was fast *because* July's audit had recorded the topology (per-user WSL, Tailscale
    SSH, split DNS). This KB exists to keep that compounding.
16. **"Dormant" is a decision deferred, and it keeps costing.** The `*.dev.test`
    routers were left in place on 2026-08-08 as "dormant, re-enable later". For four
    days they were configuration that looked live: they taught every new service the
    wrong pattern, they had to be explained in every note, and one of them was
    quietly leaking a credential. Deleting them on 2026-08-12 broke **nothing** -
    every browser-facing service already published a port, and the verification
    harness passed 20/20. **Either keep a layer working or delete it; parked
    configuration is the expensive middle.**
17. **Measure the blast radius before and after, with a number.** "22 routers → 6,
    zero Host rules, 20/20 checks passing" is what made the 08-12 deletion safe to
    do and safe to write down. A change described only in prose cannot be verified
    later.

## Client-side quirks (Windows)

16. `Invoke-WebRequest` times out on `.test` names - use `curl.exe`.
17. Chrome Secure DNS (DoH) can't resolve `.test` - looks like NXDOMAIN, isn't the box.
18. WSL distros are **per-user**; `wsl -l` never shows another user's distro.
