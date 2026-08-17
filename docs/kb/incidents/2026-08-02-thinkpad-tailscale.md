# Incident 2026-08-02 - laptop can't reach the dev stack (tunnel green, traffic dead)

**Status: RESOLVED** ~19:00 same day. Full report with complete timeline and evidence:
`C:\Users\yr055\thinkpad-tailscale-incident-2026-08-02.md` · host tailscaled log copies:
`C:\Users\yr055\ts-log-copy\`.

## Symptom
From the ThinkPad: the name layer stopped working, then SSH to the dev stack died and never
came back - while `tailscale status` on the laptop looked fine and everything worked from
the PC. Looked exactly like a dev-box failure. It wasn't; the box was healthy throughout.

## Root cause
**Half-upgraded Tailscale on the laptop**: the package on disk was upgraded (CLI 1.98.9)
but the old daemon (1.98.2) kept running - visible as a version-skew warning at the top of
every `tailscale` command. The stale daemon left `tailscale0` **without its IPv4 address**:

- Tunnel-internal checks all passed (disco pong, TSMP pong) → status green.
- Every kernel-level packet died, both directions (inbound dropped; outbound hung because
  reply SYN-ACKs were dropped coming back).
- the name layer broke first because `.test` DNS rides the same tunnel ([../dns.md](../dns.md)).
- `sudo tailscale down && up` did **not** help (same broken daemon).

## Fix
```bash
sudo systemctl restart tailscaled     # loads the upgraded binary, reprograms the interface
```
Note: the first pings after the restart still timed out for a few seconds (NAT-hairpin
path rediscovery to the WSL node) - retry before concluding failure.

## Ruled out along the way (all clean)
Dev stack (up 28h, all services answering) · Windows host (event logs spotless) ·
Tailscale keys/ACL/DERP · laptop ufw (inactive) / shields-up (false) / netfilter rules
(present) / policy routing (intact).

## What to remember
1. The **layered-ping method** that cracked it → [../runbook-cant-reach.md](../runbook-cant-reach.md).
2. **Version-skew warning ⇒ restart tailscaled before any other debugging.**
3. A wrong-username red herring: `ssh yr055@…` → "unknown user" (only `devssh` exists).
4. Found in passing: laptop's sshd not running; WSLg segfault loop on the dev box
   ([../known-issues.md](../known-issues.md)).
