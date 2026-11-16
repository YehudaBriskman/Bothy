# Install and bootstrap

The install must be **short, idempotent, honest about what it touches, and produce
mini** without questions. Everything after that is the web.

## 1. The three targets

**Runtime by host size (S0 decision):** a host with **at least 4 GiB RAM** gets the k3s
install described below; a host under 4 GiB gets the **Compose install** (a supported path;
the preflight refuses k3s there and offers Compose). Everything below is the k3s path unless
it says otherwise. Nothing here has been run on WSL itself; the lab is an Ubuntu VM (S12/S13
are configuration checks only).

| Target | How k3s gets there | Notes |
|---|---|---|
| **Linux box / VM** | the installer script | the reference path |
| **WSL2** (this box) | same script, plus WSL-specific checks | systemd must be on (it is, here); Windows keepalive is a separate opt-in module |
| **OCI Always Free A1** | `cloud-init` calls the same installer | **correction 2026-11-16:** `oci-free`'s cloud-init does *not* install k3s (it does Tailscale and the firewall guard; k3s is installed by hand, `oci-free/docs/infrastructure.md`). So there is no k3s bootstrap to reuse; only its Tailscale install is reusable. Bothy's installer would be the first scripted k3s install |

Dev (Compose) stays `just up`, untouched by this document.

## 2. What the installer does, in order

1. **Preflight** (read-only, prints and stops on failure). The list comes from the lab
   (S5b, S9 to S13) and the network review; each line says what it protects:
   - not root, and `sudo -n` works; systemd is PID 1; cgroup v2 with `cpu memory pids`
     (`/sys/fs/cgroup/cgroup.controllers`); modules `overlay`, `br_netfilter`, `vxlan`,
     `nft_nat`, `ip_set`/`xt_set` (S12), `/dev/net/tun`, `/dev/kmsg`.
   - **RAM floor and swap:** `MemAvailable` minus a reserve fits the profile (not
     `MemTotal`); **a swapless host under 4 GiB is refused** (S6); the cgroup cap counted on WSL.
   - **Disk:** `findmnt -no FSTYPE -T /var/lib/rancher/k3s` is `ext4`, `xfs` or `btrfs`;
     refuse `9p`, `drvfs`, `fuseblk`, `virtiofs`, `nfs` (S13).
   - **Ports, three views plus the firewall (S5b):** `ss -ltnH`; `docker ps --format
     '{{.Ports}}'`; every `--dport` in **both** `iptables-save -t nat` **and** `nft list
     ruleset` (Docker's nftables backend is invisible to `iptables-save`, S10). 6443, 10250, 80,
     443 and any requested port must be free in all of them. Snapshot both firewall views
     for the post-install diff, which must show **only additions** (S9 method).
   - **Docker, if present:** record `docker info` `Firewall Backend` and `iptables --version`;
     the FORWARD policy is recorded, **not relied on** (S10). Pin the backend; never switch it
     in place on a live host.
   - **Mount propagation (S11):** `findmnt -no PROPAGATION /`. If `private`, install the unit of
     step 1a.
   - **CIDRs:** 10.42/16 and 10.43/16 do not overlap any existing network (the minikube
     claim is reasoning only; minikube was not tested).
   - **Existing state:** tailscaled running and **not version-skewed** (rule 11);
     `CorpDNS`, `RunSSH`, exit-node state recorded; **no existing kubeconfig is read or written**
     (S5c: k3s writes only its own `0600` file and the installer never touches `~/.kube`).
   - `/dev/kvm` is a lab concern, not an installer one.
   1a. **The propagation unit.** A oneshot systemd unit running `mount --make-rshared /`,
   `Before=k3s.service docker.service`, installed only when `/` is `private` (it is on WSL).
   Persistence across a WSL restart is untested. Without it, pods and containers using
   `rslave`/`rshared` mounts fail with "not a shared or slave mount" (S11).
2. **Install k3s** at a **pinned version**, with flags chosen by the profile:
   `--disable metrics-server` and `--disable servicelb` (about 27 MiB together, S0; servicelb
   because the edge is published without `hostPort`, `architecture.md` s5), `--secrets-encryption`,
   `--bind-address`/`--advertise-address` plus a host firewall rule for 6443 and 10250 (both bind
   all interfaces by default), kubelet image-GC thresholds, small file-logged audit settings.
   Kubeconfig stays at k3s's default **`0600`** (the earlier `0640` is withdrawn). Whether to
   widen the NodePort range follows S1, which has **not** run.
3. **Create `bothy-system`**, the PriorityClasses, the default LimitRange, and
   NetworkPolicy defaults.
4. **Generate secrets**: the settings master key (a **host file** `0600`, root, outside the
   datastore; never printed; `settings-store.md` s9), cookie secrets, and the first-run
   credential per s4 (**not** printed on a non-TTY).
5. **Install the core chart** by digest, `helm upgrade --install --atomic --wait`.
6. **Verify by bytes**: the portal answers with the SPA, the API answers JSON, the
   catch-all does not answer for an unknown path. Print the URL.
7. **Write a receipt** to `$STATE_ROOT/bothy/install.json` (versions, digests, time,
   what was created), which is what uninstall reads.

It never edits Windows settings, never changes DNS, never writes outside
`$HOME`, `/etc/rancher`, and k3s's own paths, and says so up front (the existing
installer test "stays inside `$HOME`" extends to a list of allowed system paths).

## 3. Delivery: `curl | sh` and its honesty

The existing `bothy` installer clones the repo, verifies, and stays in `$HOME`. The
k3s path adds a **checksum-pinned** step: the script fetches the k3s installer at a
pinned version and verifies its sha256 before running it, and prints what it will
run. Offline/air-gapped is a later option (k3s supports an images tarball); it is
noted, not designed here.

## 4. First sign-in (#319)

- URL printed at the end: `http://<ip>:<port>`.
- **The one-time password must not be emitted on a non-TTY.** cloud-init output is
  world-readable on the node, so the unattended path uses a **short-lived claim token**
  (`bothy admin init` redeems it from the host) or a **user-supplied hash**. On a TTY the
  password is shown once and stored **only as a hash**.
- A lost password is recovered by a **host-only reset** (`bothy admin reset`), which must
  need **root on the node and the host-side KEK path**, not "anyone who can read the
  kubeconfig" (which is root-only, `0600`). Not an email flow.
- **Refuse or loudly warn** if the first sign-in would happen over plain HTTP on a LAN
  address (`modes-and-modules.md` s3).
- At first sign-in rotation is forced; then the wizard (`modes-and-modules.md` s6).

## 5. Repeatability

- **Re-running the installer is safe**: it detects the receipt, diffs the desired vs
  actual (k3s version, chart digests), and only changes what differs.
- **`bothy install --mode=standard`** (non-interactive) applies a mode at install
  time for people who script it. Same code as the wizard.
- A **dry run** prints the plan with the budget arithmetic and exits.

## 6. Uninstall and reset

| Command | Effect |
|---|---|
| `bothy uninstall` | removes the core chart and module namespaces, **keeps PVCs and the key**, k3s stays |
| `bothy uninstall --purge` | typed confirmation; also deletes PVCs and uninstalls k3s via its own uninstall script; leaves only the receipt and backups. **Docker modules and Docker's firewall rules are left intact**: `k3s-killall.sh` and `k3s-uninstall.sh` removed 314 k3s iptables lines and added none, Docker's 29 identical (S9). Not tested: a concurrent Docker network create during killall |
| `bothy reset-first-run` | back to the first-run wizard without touching data |

Uninstall must leave nothing the receipt did not create (the existing CI rule: "`down`
leaves nothing", extended).

## 7. WSL2-specific checks (from the notes' hard-won rules)

- **Tailnet reachability (design open, 2026-11-16 review):** the first draft said k3s
  `--node-ip` and Traefik bind to the tailnet address. That is **wrong or fragile**:
  hostPort/ServiceLB listens on *all* interfaces (DNAT, not a bound socket), a
  listener bound to `100.x` before tailscaled is up gets EADDRNOTAVAIL, and `--node-ip`
  fails at boot if the interface is absent. Candidates: a stable dummy-interface node
  IP plus a host firewall rule on `tailscale0`, or hostNetwork Traefik with
  `net.ipv4.ip_nonlocal_bind=1` and `After=tailscaled`. This is spike S8 (see
  `review-findings.md`); until it passes no claim of tailnet-only exposure stands.
- **Not tested, so not promised on WSL:** `wsl --shutdown` recovery (the keepalive task),
  the propagation unit's persistence, and the WSL kernel actually running k3s (S12, S13 are
  read-only checks of its config and filesystem).
- **No portproxy additions** (rule 5): ports are published by Traefik/k3s, never by
  Windows scripts.
- **No bare hostnames in host processes** (rule 8): the node uses dnsmasq's
  `domain-needed` behaviour; cluster DNS names resolve only inside the cluster.
- **The keepalive task** is the one Windows dependency, kept as the optional
  `windows-host` module.

## 8. Failure and recovery

A failed install is **resumable**: each step records itself in the receipt, a rerun
continues from the failed step, and a failed core chart leaves k3s installed and the
error printed with the single command to retry. A half-applied module is rolled back
by the operator before the failure is reported.

## 9. Disaster recovery and backups (new)

- **A recovery bundle is forced at install:** an age-encrypted export (`settings-store.md` s11)
  plus the receipt. The owner's decision (Q2) keeps the off-box recipient key an **advisory**
  with a persistent `just doctor` warning until one exists, so this step produces the bundle and
  says where it must be moved; it cannot force an off-box copy without blocking a first install.
- **Backup placement** (`hybrid-runtime.md` s3): Docker data keeps the host `backup.sh` and
  timer. k3s state gets a host-side backup (SQLite datastore is a **consistent file copy**;
  there is **no etcd snapshot**). **An off-node target is required** for `backups` to count as
  enabled. The master key is a **host file outside the datastore**, so a datastore backup is
  key-bearing only if the admission policy has put a copy in the cluster (`security-model.md` 6.2).
- `bothy restore` is tested monthly into a scratch VM (`modes-and-modules.md` s8); an untested
  backup is not a backup.

## Changed 2026-11-16

- s1: 4 GiB floor (S0). s2 step 1: preflight replaced by the measured list (S5b, S6, S9 to S13);
  step 1a (rshared unit) added (S11). Step 2: `servicelb` disabled, bind address, kubeconfig `0600`
  (S5c; `0640` withdrawn). Step 4: master key is a host file. s4: no password on a non-TTY.
  s6: Docker rules survive uninstall (S9). s7: untested-on-WSL list. s9 is new.
- **ASSUMPTION:** `--disable servicelb` plus a hostNetwork or Service-based edge works from a
  tailnet peer; settled by S1/S8 (Tailscale in the lab). The existing tailnet-reachability bullet
  in s7 stands.