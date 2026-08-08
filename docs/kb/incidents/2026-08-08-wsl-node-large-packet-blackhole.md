# 2026-08-08 — WSL-node tunnel dropped large packets (headers passed, bodies stalled)

**Fix: restart tailscaled on the box.** No version skew involved this time — the fresh
WireGuard handshake / new WinNAT mapping is what healed it.

## Symptom (from the PC, node `yehuda-hs`)

- `tailscale ping` / `--tsmp` / `--icmp` to 100.117.176.85: all pong in 1–2 ms.
- `curl http://100.117.176.85/`: **401 header arrives instantly, body stalls at 0 bytes**
  until `--max-time` kills it. (`-o NUL -w "%{http_code}"` alone shows a healthy-looking
  401 — always check `%{size_download}` too.)
- `ssh devssh@100.117.176.85` usually hung at `expecting SSH2_MSG_KEX_ECDH_REPLY`
  (OpenSSH 10 defaults to mlkem768x25519 — its ~1.2 KB server reply is over the hole's
  threshold). Occasionally a session squeaked through — flaky, not absolute.
- Meanwhile `http://100.93.197.10/` (host node → portproxy → vSwitch) delivered the full
  body instantly, and `localhost` too → **the box was healthy; only the tunnel path
  PC→WSL-node was broken.**

## Diagnosis method (add to the layered-ping playbook)

1. Full-body curl with `%{size_download}`, not just status codes.
2. Size the hole with plain tunnel pings: `ping -l <N> 100.117.176.85` at 400/800/1000/
   1150/1200. This incident: **≤1150 passed, ≥1200 dropped** (encapsulated UDP ≳ ~1260 B
   died on the WinNAT hairpin — endpoint was `192.168.68.50:59803`, i.e. the PC's own
   LAN IP hairpinning through WinNAT into the WSL guest).
3. **Emergency SSH when KEX hangs:** force a small handshake —
   `ssh -o KexAlgorithms=curve25519-sha256 -o HostKeyAlgorithms=ssh-ed25519 devssh@100.117.176.85`
   — connects instantly through the hole. Keep remote command *output* small too (box→PC
   data segments are still MSS-sized, ~1240 B, and get eaten); `| head`/`wc -l` everything
   until the path is fixed.
4. Then restart tailscaled **detached** (never ride the session you're killing):
   `sudo systemd-run --on-active=3 --unit=ts-restart-now systemctl restart tailscaled`

## Ruled out / notes

- No client↔daemon version skew on either end (both 1.98.9; 1.102.2 available, not installed).
- tailscaled had been up since the 2026-08-01 cold boot and everything worked on 08-02 —
  so the wedge developed in the long-lived NAT mapping/session, not from an upgrade.
- PC-side `tailscale down/up` did NOT fix it (cycles state, keeps the daemon+mapping).
- Fallback if a restart ever doesn't heal it: lower the box's tunnel MTU
  (`sudo ip link set dev tailscale0 mtu 1130`, persist with `TS_DEBUG_MTU=1130` in a
  systemd drop-in). Not needed this time.
- devssh had **no Windows session**, so the schtasks `/IT` trick was unavailable — the
  small-KEX SSH trick above was the only way in. Remember devssh's login shell is **zsh**:
  `echo ===` breaks (`zsh: == not found`); pipe scripts to `bash -s` instead.
- **New since 2026-08-02:** Tailscale SSH showed a **check-mode** prompt once
  (`# To authenticate, visit: https://login.tailscale.com/a/…`) — the ACL apparently now
  has `action: check`. Cached afterwards; unattended SSH can stall on it when the cache
  expires. Decide in the admin console (ACL SSH rule → `accept`) if unattended SSH matters.
