# lab/ - disposable VMs for testing Bothy installs

Design: `docs/plans/thin-bothy/vm-lab-and-connectivity.md` (section A). One script, `lab.sh`;
all state in `~/lab/` (never in the repo).

```
lab/lab.sh check | fetch | up <profile> | ssh <profile> [cmd] | status | down <profile> | reset <profile> | destroy <profile>
profiles: lab-mini (1 vCPU, 2 GiB)   lab-mid (2 vCPU, 4 GiB)   lab-std (4 vCPU, 6 GiB)
```

Needs `qemu-system-x86 qemu-utils cloud-image-utils` and membership of group `kvm`.

## What it enforces
- **Memory gate:** refuses to start if less than `RESERVE_MIB` (default 4096, floor 2048) of
  `MemAvailable` would remain, or if memory pressure (PSI `some avg10`) is above `PSI_MAX` (10).
  Swap is shown, not gated: on a box whose swap is already full, a swap gate refuses everything.
- **Per-VM cgroup scope:** `MemoryMax`, `MemoryHigh` (95%), `MemorySwapMax=0`, `CPUQuota`.
- **Host forwards on 127.0.0.1 only** (ssh 2222 / portal 18080 for lab-mini).
- **Base image checksum-verified** before use; a failed fetch leaves nothing behind.
- Never touches Docker, iptables, `.wslconfig`, DNS or the Windows side.

## Known gap: the guest can reach the host (spike S15, measured 2026-11-16)
QEMU user-mode networking exposes the host's loopback to the guest as `10.0.2.2`. cloud-init
drops NEW guest->`10.0.2.2` connections at every boot. Measured on `lab-mini`:

| State | Guest -> host port 8080 |
|---|---|
| rule in place | blocked |
| rule removed by guest root | **reachable** (HTTP 302) |

So the rule only stops accidents. **Treat the lab as safe for our own installer and k3s tests,
not for running untrusted code.** Real isolation needs `restrict=on` with a single allowed proxy
for apt and image pulls; not built yet.

## Not here yet
Tailscale (the lab key is created only when the Tailscale tests start, and is read from
`~/lab/secrets/ts-authkey`, never from argv), `just` recipes, snapshots.
