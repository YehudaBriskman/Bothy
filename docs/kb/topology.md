# Topology — machines, users, addresses

_Verified 2026-08-02. DHCP/NAT addresses rotate — trust names and tailnet IPs, not LAN IPs._

## The one fact that explains everything

**The "dev box" is not a separate machine.** It is a WSL2 Ubuntu distro on the Windows PC
`Yehuda-HS`, registered under a **second Windows user `devssh`** — invisible to `wsl -l`
from yr055, running in its own utility VM, with its own Tailscale node *inside* the distro.

## Tailnet (tailnet suffix `tail7e7e3b.ts.net`, account YehudaBriskman@github)

| Node | Tailscale IP | What it actually is | Key expiry |
|---|---|---|---|
| `yehuda-hs` | 100.93.197.10 | The Windows PC itself (host OS) | 2027-01-17 |
| `yehuda-wsl` | **100.117.176.85** | **The dev box** — devssh's WSL distro on that same PC. Hostname override; internal hostname is also `Yehuda-HS` | 2027-01-12 |
| `yehuda-thinkpad` | 100.108.35.26 | The Linux laptop | 2027-01-16 |
| `iphone-14` | 100.101.204.32 | Phone (useful as an independent tailnet test client) | — |

~~`dev.test` and `*.dev.test` all point at 100.117.176.85~~ **Retired** — dormant
2026-08-08 (split-DNS route removed), **deleted 2026-08-12** (every Traefik `Host()`
router removed). Access is IP:port on 100.117.176.85 (see [access.md](access.md));
[dns.md](dns.md) records what survives and why restoring names is a rebuild.
MagicDNS (`yehuda-wsl.tail7e7e3b.ts.net`) is unaffected and still works.

## The Windows PC (`Yehuda-HS`, Windows 11 Pro)

- LAN: Realtek 2.5GbE, **DHCP — was `192.168.68.57` until 2026-08-01, now `192.168.68.52`**
  (changed with the reboot after the [ethernet incident](incidents/2026-08-01-ethernet-ndis.md)).
  Anything hard-coding a LAN IP will eventually lie — the postboot checker did.
- Network is **double NAT**: TP-Link mesh `192.168.68.1` behind ISP router `192.168.1.x`.
- Runs **two separate WSL2 utility VMs** (two `vmmemWSL` processes — the healthy count is 2):
  - **devssh's VM** = the dev box. Ubuntu 24.04, systemd PID 1, docker + ~25 containers,
    tailscaled with `RunSSH: true`. Starts 16s after boot via the keepalive task
    ([always-on.md](always-on.md)).
  - **yr055's VM** = `Ubuntu` + `docker-desktop` (Docker Desktop k8s, minikube, ollama, LXC).
    Unrelated to the dev stack — auditing it finds nothing, by design.
- WSL guest IPs live on the `WSL (Hyper-V firewall)` switch (`192.168.96.1/20` side) and
  **rotate on every WSL restart** (devssh's was `.43` in July and again on 2026-08-02 — luck,
  not stability).
- The host also runs its own **Windows OpenSSH sshd on :22** (password auth) — distinct from
  the dev box's port 22. See [access.md](access.md).

## How the dev box reaches the internet / tailnet

The WSL VM is NATed behind the Windows host, so `yehuda-wsl`'s tailnet endpoint is **the
host's own LAN IP with a rotating UDP port** (a NAT hairpin, e.g. `192.168.68.52:51029`).
Consequences:

- When that NAT port rotates, peers keep sending to the stale port for a bit — SSH to the
  dev box **hangs for seconds-to-minutes, then self-heals** once disco re-resolves. Seen
  live 2026-08-02 17:55–18:06. Not a fault; retry before diagnosing.
- After idle periods the first connection needs a fresh WireGuard handshake — same symptom,
  same advice.
- The wsl node also advertises useless Docker-bridge endpoints (172.17–21.x, 192.168.49.1),
  which slows path discovery slightly.

## The laptop (`yehuda-thinkpad`)

- Linux, tailscale (had the 2026-08-02 [half-upgrade incident](incidents/2026-08-02-thinkpad-tailscale.md)).
- LAN `192.168.68.59` when home (DHCP); roams to iPhone hotspot (172.20.10.x) outside.
- **Its own sshd is NOT running** (confirmed 2026-08-02) — you cannot SSH *to* the laptop.

## Related: see also

[access.md](access.md) for how to reach each of these · [dns.md](dns.md) for names ·
[always-on.md](always-on.md) for lifecycle · [architecture.md](architecture.md) for what's inside the box.
