# Spike results

Measured in the VM lab (`lab/lab.sh`, merged in #340). Each result says what it changes in the plans.
All numbers are from a `lab-mini` guest (1 vCPU, 2 GiB, Ubuntu 24.04 cloud image).

## S0: what does k3s cost at idle? (2026-11-16)

Stock k3s v1.37.2 (stable channel), SQLite datastore, defaults, no Bothy workloads, 3 minutes to settle.

| | MiB used |
|---|---|
| OS before k3s | 319 |
| After k3s settled | 975 |
| **k3s tax** | **about 656** |
| k3s server process RSS | 694 |
| Left available on a 2 GiB guest | 992 |

Stock pods are small (Traefik 18, metrics-server 16, CoreDNS 10, local-path 6, svclb 0 MiB).
The cost is the k3s server itself. Disabling `metrics-server` and `servicelb` saved about 27 MiB
(tax about 630, server RSS 698): **trimming does not change the order of magnitude.**

**What it changes:** the plans gave Bothy's own pieces about 170 MiB. On k3s a mini install is about
0.8 GiB (k3s tax + core, core not yet measured), against about 0.17 GiB for the same core under Compose.
So k3s is not "thin" in absolute terms; it buys self-healing, atomic upgrades and resource
policy at roughly 0.65 GiB.

**Decision (by the goal of #315, that many people can install it):**
- **k3s-first applies to hosts with at least 4 GiB RAM** (an OCI A1 or any ordinary VM). The tax is under 20% of
  the box and the guarantees are worth it.
- **Hosts under 4 GiB get the Compose install**, a supported path, not a failure mode. The hybrid design
  already keeps Compose, so this costs no new work except documenting the floor in the installer preflight.
- The installer's preflight refuses k3s below the floor and offers Compose.

Open: the floor of 4 GiB is a judgement from this one number; confirm with `lab-std` once core exists.

## S15: can the lab guest reach the host? (2026-11-16)

QEMU user networking shows the host's loopback to the guest as `10.0.2.2`. cloud-init drops NEW
connections to it at each boot.

| State | Guest to host port 8080 |
|---|---|
| rule in place | blocked |
| rule removed by guest root | **reachable** (HTTP 302) |

**What it changes:** the lab is for our own installer and k3s tests, never for untrusted code. Real
isolation (`restrict=on` plus one allowed proxy) is future work; see `lab/README.md`.
