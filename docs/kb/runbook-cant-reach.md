# RUNBOOK - "I can't reach the dev stack"

_Every alarm so far (2026-07-21 ×2, 2026-08-02) was the **client**, not the box.
Work the steps in order; each takes seconds._

## Step 0 - Is the client on the tailnet? (the #1 cause)

On the failing device: `tailscale status`. If it errors, shows logged-out, or shows the
device offline - that's your problem, full stop.

_(Historically the tell was that the name layer died alongside SSH, because names needed the
tunnel for DNS too. Names are retired as of 2026-08-08/08-12 ([dns.md](dns.md)), so that
signal is gone - **probe `http://100.117.176.85:<port>`**, and never spend time on a
failing `.test` lookup: it is expected to fail.)_

**And check the top of that output for a version-skew warning:**

```
Warning: client version "X" != tailscaled server version "Y"
```

If present → the package was upgraded but the old daemon is still running. It can be
subtly broken while showing green (2026-08-02: interface lost its IP).
**`sudo systemctl restart tailscaled` FIRST, before any other debugging.**
(`tailscale down && up` does NOT fix this - it cycles the same broken daemon.)

## Step 1 - Layered pings from a known-good node (PC or phone)

```
tailscale ping 100.117.176.85            # disco: is a path findable?
tailscale ping --tsmp 100.117.176.85     # through the tunnel, answered by tailscaled
tailscale ping --icmp 100.117.176.85     # through the tunnel, answered by the OS kernel
ping 100.117.176.85                      # normal traffic
```

| Result | Broken layer | Do |
|---|---|---|
| All pong **but pages stall / SSH hangs at KEX** | **Large-packet blackhole** - small packets pass, full-size die | Confirm: `curl` shows a code but `%{size_download}`=0; `ping -l 1150` pongs, `-l 1200` dies. Fix: restart tailscaled ON THE BOX (small-KEX SSH door in [access.md](access.md)) - [incidents/2026-08-08](incidents/2026-08-08-wsl-node-large-packet-blackhole.md) |
| All pong | Nothing network-side | Check application: username `devssh@`? sshd vs Tailscale-SSH confusion? Check-mode prompt waiting for a browser click? ([access.md](access.md)) |
| disco+TSMP pong, ICMP dead | **Peer's kernel/interface/firewall** - tunnel is fine but the OS drops packets | On the peer: `ip -4 addr show tailscale0` (must show its 100.x/32 - **empty = the 2026-08-02 bug**, restart tailscaled); then ufw/nftables `ts-input` rules; `ip rule show` (5210/5230/5250/5270 + `lookup 52`) |
| disco pongs, TSMP dead | WireGuard session broken | Restart tailscaled on the peer |
| Nothing pongs | Node truly offline | Its machine/network/daemon is down - see below |
| First pings time out, then work | **NAT-hairpin port rotation / idle handshake** - normal for the WSL node | Wait ~30s, retry. Self-heals ([topology.md](topology.md)) |

## Step 2 - Is the box itself up? (rarely the answer, verify anyway)

From yr055 on the PC (names retired - probe the IP, and read **bytes as well as
code**; "200 with 0 bytes" = blackhole, see step 1). Note that `:80` answers 200 for
anything, so add a probe on a service's own port to learn something:

```powershell
(Get-Process vmmemWSL -ErrorAction SilentlyContinue).Count    # want 2
curl.exe -s -o NUL -w "%{http_code} %{size_download}" http://100.117.176.85/       # portal: want 200 + >0 bytes
curl.exe -s -o NUL -w "%{http_code} %{size_download}" http://100.117.176.85:3000/ # grafana: a real service, want 200/302 + >0 bytes
tailscale status | findstr yehuda-wsl                         # want active/idle
ssh -o ConnectTimeout=10 devssh@100.117.176.85 "docker ps --format '{{.Names}}' | wc -l"   # want ~29
```

If vmmemWSL count < 2 or the node is offline → [always-on.md](always-on.md) recovery:
elevated `schtasks /run /TN "DevBox-WSL-Keepalive"`, or log in as devssh once.

## Step 3 - Known lookalikes (do not chase these)

- ~~401 or a sign-in page is SUCCESS~~ **Obsolete since 2026-08-08: SSO is dormant.
  Portal :80 should be 200; a 401 anywhere now means something regressed.**
- `ssh yr055@…` → "unknown user"; only `devssh@` exists on the dev box.
- SSH prints `# To authenticate, visit: https://login.tailscale.com/a/…` and waits -
  that's Tailscale SSH **check-mode** (new since 08-08), not a fault. Click the link.
- `Invoke-WebRequest` timing out - .NET quirk; use `curl.exe`. (It bit on the name layer
  names; the rule survives them.)
- **the name layer NXDOMAIN from any device - that is the expected state since
  2026-08-08/08-12, not a fault.** Use `http://100.117.176.85:<port>`.
- A 200 from a weird hostname or a nonsense path - `portal-next-fallback` answers
  everything on `:80`; proves nothing. Since 2026-08-12 it is the only non-API router,
  so this is now the *normal* response rather than an edge case.
- **`a service hostname` / the Traefik dashboard is 404/gone** - deleted deliberately
  2026-08-12 ([lessons.md](lessons.md)). Router table:
  `http://100.117.176.85/-/api/traefik/http/routers`.
- **`*.a service hostname` routers reappearing in the router table** - a Tals preflight
  script regenerates them; inert, known ([known-issues.md](known-issues.md)).
- SSH hangs to the dev box for a minute after long idle - hairpin port rotation; retry.
- Checker says `TASK MISSING` / probes `000` on the old IP - run elevated; stale `.57` IP
  ([runbook-post-reboot.md](runbook-post-reboot.md)).

## The mindset (from three incidents)

The box has survived every incident so far; the failing part was a client's tunnel, a
client's DNS stack, or a stale assumption. **Prove which side is broken with layered
pings before touching the box.** Diagnose from two vantage points (PC *and* phone) -
if both fail identically, then believe it's the box.

Incidents this runbook was distilled from:
[2026-07-21](incidents/2026-07-21-wsl-idle-timeout.md) ·
[2026-08-01](incidents/2026-08-01-ethernet-ndis.md) ·
[2026-08-02](incidents/2026-08-02-thinkpad-tailscale.md)
