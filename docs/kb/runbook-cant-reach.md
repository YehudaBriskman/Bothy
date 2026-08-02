# RUNBOOK — "I can't reach the dev stack"

_Every alarm so far (2026-07-21 ×2, 2026-08-02) was the **client**, not the box.
Work the steps in order; each takes seconds._

## Step 0 — Is the client on the tailnet? (the #1 cause)

On the failing device: `tailscale status`. If it errors, shows logged-out, or shows the
device offline — that's your problem, full stop. `dev.test` needs the tunnel for **DNS
too** ([dns.md](dns.md)), so tunnel-down kills names *and* SSH together.

**And check the top of that output for a version-skew warning:**

```
Warning: client version "X" != tailscaled server version "Y"
```

If present → the package was upgraded but the old daemon is still running. It can be
subtly broken while showing green (2026-08-02: interface lost its IP).
**`sudo systemctl restart tailscaled` FIRST, before any other debugging.**
(`tailscale down && up` does NOT fix this — it cycles the same broken daemon.)

## Step 1 — Layered pings from a known-good node (PC or phone)

```
tailscale ping 100.117.176.85            # disco: is a path findable?
tailscale ping --tsmp 100.117.176.85     # through the tunnel, answered by tailscaled
tailscale ping --icmp 100.117.176.85     # through the tunnel, answered by the OS kernel
ping 100.117.176.85                      # normal traffic
```

| Result | Broken layer | Do |
|---|---|---|
| All pong | Nothing network-side | Check application: username `devssh@`? sshd vs Tailscale-SSH confusion? ([access.md](access.md)) |
| disco+TSMP pong, ICMP dead | **Peer's kernel/interface/firewall** — tunnel is fine but the OS drops packets | On the peer: `ip -4 addr show tailscale0` (must show its 100.x/32 — **empty = the 2026-08-02 bug**, restart tailscaled); then ufw/nftables `ts-input` rules; `ip rule show` (5210/5230/5250/5270 + `lookup 52`) |
| disco pongs, TSMP dead | WireGuard session broken | Restart tailscaled on the peer |
| Nothing pongs | Node truly offline | Its machine/network/daemon is down — see below |
| First pings time out, then work | **NAT-hairpin port rotation / idle handshake** — normal for the WSL node | Wait ~30s, retry. Self-heals ([topology.md](topology.md)) |

## Step 2 — Is the box itself up? (rarely the answer, verify anyway)

From yr055 on the PC:

```powershell
(Get-Process vmmemWSL -ErrorAction SilentlyContinue).Count    # want 2
curl.exe -s -o NUL -w "%{http_code}" http://dev.test/         # want 401 (= up + SSO)
tailscale status | findstr yehuda-wsl                         # want active/idle
ssh -o ConnectTimeout=10 devssh@100.117.176.85 "docker ps --format '{{.Names}}' | wc -l"   # want ~24
```

If vmmemWSL count < 2 or the node is offline → [always-on.md](always-on.md) recovery:
elevated `schtasks /run /TN "DevBox-WSL-Keepalive"`, or log in as devssh once.

## Step 3 — Known lookalikes (do not chase these)

- **401 or a sign-in page is SUCCESS** — SSO is in front of most services ([architecture.md](architecture.md)).
- `ssh yr055@…` → "unknown user"; only `devssh@` exists on the dev box.
- `Invoke-WebRequest` timing out on `*.dev.test` — .NET quirk; use `curl.exe`.
- Browser NXDOMAIN with curl fine — Chrome DoH; it can't see `.test`.
- A 200 from a weird hostname — `portal-fallback` answers everything; proves nothing.
- SSH hangs to the dev box for a minute after long idle — hairpin port rotation; retry.
- Checker says `TASK MISSING` / probes `000` on the old IP — run elevated; stale `.57` IP
  ([runbook-post-reboot.md](runbook-post-reboot.md)).

## The mindset (from three incidents)

The box has survived every incident so far; the failing part was a client's tunnel, a
client's DNS stack, or a stale assumption. **Prove which side is broken with layered
pings before touching the box.** Diagnose from two vantage points (PC *and* phone) —
if both fail identically, then believe it's the box.

Incidents this runbook was distilled from:
[2026-07-21](incidents/2026-07-21-wsl-idle-timeout.md) ·
[2026-08-01](incidents/2026-08-01-ethernet-ndis.md) ·
[2026-08-02](incidents/2026-08-02-thinkpad-tailscale.md)
