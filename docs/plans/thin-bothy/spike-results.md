# Spike results

Measured in the VM lab (`lab/lab.sh`, merged in #340). Each result says what it changes in the plans.
S0 and S15 are from a `lab-mini` guest (1 vCPU, 2 GiB); S5b to S13 from a `lab-mid` guest (2 vCPU, 4 GiB); both Ubuntu 24.04 cloud image.

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

## Coexistence spikes S5b, S5c, S6, S9 to S13 (2026-11-16)

Setup: `lab/lab.sh up lab-mid` (2 vCPU, 4 GiB, no swap), Ubuntu 24.04 guest kernel 6.8.0-147-generic,
Docker 29.1.3 (`docker.io`, firewall backend `iptables`, which is iptables-nft 1.8.10), k3s v1.37.2+k3s1
from `curl -sfL https://get.k3s.io | sh` run inside the guest (defaults: flannel vxlan, Traefik, servicelb,
kube-router network policy). Probes were plain busybox `httpd` containers and pods; scripts were fed to
`lab.sh ssh lab-mid 'bash -s'`. **The VM's Ubuntu kernel is not the WSL kernel**: every guest result
below is about Docker + k3s userland behaviour, not about WSL kernel support (see S12/S13).
Side finding: the lab's slirp resolver (10.0.2.3) returns NXDOMAIN for `example.com`; probes used
`archive.ubuntu.com`. Unrelated to the spikes.

### S5b: Docker port vs. k3s hostPort on the same port. Result: PASS (with a sharper rule than the plan)

The plan said "bind() never fails, second DNAT rule, first wins". Measured: **bind() never fails, in either
order, and which DNAT wins depends on the packet path and on which daemon touched the chain last.**

```
docker run -d --name d1 -p 9090:80 busybox httpd...       # docker-proxy listens 0.0.0.0:9090
kubectl apply -f p1.yaml   # hostPort 9090  -> Running, no error, no event
ss -ltnH diff before/after the pod:  identical (portmap/CNI hostPort opens NO listener)
iptables-save -t nat diff:  + CNI-DN-<hash> chain (DNAT --to 10.42.0.10:80) + 1 jump from CNI-HOSTPORT-DNAT
nft list ruleset:           same additions, in the iptables-nft "ip nat" table
```

Chain order was `PREROUTING: KUBE-SERVICES, DOCKER, CNI-HOSTPORT-DNAT` (same in OUTPUT). Winner by path
(body returned by the service):

| Path to :9090 | Winner |
|---|---|
| `curl localhost` / node IP on the host (OUTPUT) | DOCKER |
| a pod to the node IP | DOCKER |
| a container on `docker0` to the node IP or 172.17.0.1 (PREROUTING; the DOCKER rule has `! -i docker0`) | **POD** |
| container stopped (docker-proxy and DNAT gone) | POD, for everyone |

Reverse order (pod on 9091 first, then `docker run -p 9091:80`): `docker run` exits 0, docker-proxy binds, Docker wins
from the host and the pod wins from `docker0`. **After `systemctl restart docker` the order flipped to
`CNI-HOSTPORT-DNAT, DOCKER`** (Docker re-inserted its jump after k3s's) and the pod then won everywhere. So the
winner is not stable across restarts. A plain host process (python on 9092) plus a pod hostPort 9092: the pod is
created and silently shadows the host listener (curl returned the pod). A genuine `bind()` failure happens only
Docker-vs-host-process (`failed to bind host port 0.0.0.0:9092/tcp: address already in use`), never involving hostPort.

**What it changes:** the preflight must check three things, not one: `ss -ltnH` (host listeners and docker-proxy),
the published ports of running containers (`docker ps --format '{{.Ports}}'`), and every `--dport` in
`iptables-save -t nat` (`CNI-DN-*`, `DOCKER`). Rule for Bothy: **Bothy's k3s modules never use `hostPort`** (use the
Traefik service on a port preflight has proven free) and every Docker-module port is allocated from the same registry
as k3s service ports. The "before/after diff of `iptables-save -t nat` for the live containers" stays a valid
acceptance gate. Not run: the 32 live containers (this is a lab).

### S5c: restarts and kubeconfig. Result: PASS; two items INCONCLUSIVE (`wsl --shutdown`, minikube)

Containers had `--restart unless-stopped`; probe: `wget` of an `archive.ubuntu.com` URL from a pod and from a container.

| Action | Containers | Pods | Egress |
|---|---|---|---|
| `systemctl restart docker` with k3s up | recovered (`Up 8 seconds`, new StartedAt) | untouched: restart counts and pod IPs identical | pod OK, container OK |
| `systemctl restart k3s` with Docker up | untouched (same StartedAt) | all Running again in about 40 s, same IPs (metrics-server slower to be Ready) | pod OK, container OK, a **new** pod OK |
| container **without** a restart policy, Docker restarted | stays `Exited` (live-restore is off) | n/a | n/a |

Kubeconfig: a canary `~/.kube/config` (sha256 and mtime) was created first; after both restarts and a **re-run of the
get.k3s.io installer** hash and mtime were unchanged. k3s wrote only `/etc/rancher/k3s/k3s.yaml` (root, 0600);
`sudo k3s kubectl` creates `/root/.kube/cache` (discovery cache), never `config`.

Not tested: `wsl --shutdown` (forbidden) and minikube (not in the VM; its docker-driver bridge, and the claim that
10.42/16 and 10.43/16 do not overlap it, remain reasoning only).

**What it changes:** every Bothy Docker module needs `restart: unless-stopped` (or `always`), otherwise a Docker restart
drops it while the k3s core keeps running. The installer never writes `~/.kube`; a user kubeconfig entry, if wanted,
is a separate explicit command (`k3s kubectl config view --raw`).

### S6: Docker module over its limit, core unaffected. Result: PASS for a limited container; **hazard for an unlimited one**

`docker run --memory 64m --memory-swap 64m` allocating 200 MB inside (pid 1 kept alive so the cgroup can be read):

```
docker-<id>.scope/memory.max     67108864
docker-<id>.scope/memory.events  max 18  oom 1  oom_kill 1  oom_group_kill 0
system.slice/k3s.service, kubepods.slice, docker.service, containerd.service  memory.events: all zero, before and after
sum of oom_kill over every cgroup under kubepods.slice: 0; pod restart counts unchanged; k3s and docker active
kernel: Memory cgroup out of memory: Killed process (sh) ... oom_memcg=/system.slice/docker-<id>.scope
```

A container that hits its own cgroup limit is the only thing killed (`docker inspect`: `OOMKilled=true`).

`oom_score_adj` (measured): `k3s-server -999`, `dockerd -500`, Docker's containerd -999, k3s containerd-shim 1,
Docker containers 0. **k3s pods get adj by QoS class: BestEffort 1000, Burstable 983**; in this install Traefik, svclb,
CoreDNS, local-path and the test pods were BestEffort or Burstable. Kernel ranking (`/proc/*/oom_score`) with an
unlimited Docker container holding 1.8 GiB at adj 0:

```
score=1349 adj=1000 rss=96MiB   traefik          <- ranked first
score=1333 adj=1000 (httpd pods)   score=1331 adj=983 coredns
score= 736 adj=0    rss=409MiB (the Docker sh)   score=734 adj=100 systemd
```

adj 1000 adds a whole memory's worth of score, so **under a global OOM every BestEffort pod outranks any Docker
container, whatever its size** (ranking only: no kill observed). With `--oom-score-adj=1000` the hog ranked first (1415), so
adjusting does matter. A real global OOM (unlimited container allocating 5 GB on the 4 GiB, swapless guest) was run
once: **the guest wedged for more than 8 minutes** (ssh banner timeouts, qemu at 100% CPU), the last journal line was
`k3s-server invoked oom-killer` and journald stopped logging, so the victim was **not observed** and the VM was
powered off. INCONCLUSIVE on who dies; a measured hazard on "the host stays usable". Part of the stall may be the lab's
serial console; not isolated. A Guaranteed pod's adj was not measured (documented value -997).

**What it changes:** (1) every Docker module **must** carry a memory limit and a positive `oom_score_adj`
(suggest 500 to 1000); with a limit the case passes. (2) Bothy's k3s core pods must be **Guaranteed** (requests equal
limits); the stock add-ons are not. (3) Preflight refuses hosts with no swap and under 4 GiB, and the budget gate
counts Docker module limits so a global OOM is never reached. (4) Re-measure the victim on a host with swap before
the go/no-go is final.

### S9: `k3s-killall.sh` and `k3s-uninstall.sh` leave Docker alone. Result: PASS

Containers `pub9` (published 9393), `nets`, `dc`, plus a user network; `iptables-save` normalised (counters zeroed),
`nft list ruleset`, links.

| | iptables lines | Docker lines (DOCKER, docker0, 172.17, br-) | k3s lines (KUBE, CNI, FLANNEL, 10.42/43) |
|---|---|---|---|
| before | 366 | 29 | 314 |
| after `k3s-killall.sh` | 52 | 29 (**identical**) | 0 |
| after `k3s-uninstall.sh` | 52 | 29 (**identical**) | 0 |

The diff is 314 removed lines and 0 added. Containers kept StartedAt, pid and restart count; the published port
answered; container egress and a new container with a new published port worked after both scripts; a Docker restart
afterwards was fine. `cni0`, `flannel.1` and the pod veths were removed, `docker0` untouched; `ip_forward` stays 1.
Not tested: killall's `iptables-save | iptables-restore` flush racing a concurrent Docker network create.

**What it changes:** "remove k3s" is a rollback that does not endanger Docker modules; the uninstall path may call the stock scripts.

### S10: Docker restart and pod egress; firewall backend. Result: PASS, with a pin

Pod and container egress were OK after `systemctl restart docker` (S5c). `docker info`: `Firewall Backend: iptables`
(Docker 29.1.3, Ubuntu 24.04). `iptables -S FORWARD`: `-P FORWARD DROP` when Docker enabled forwarding first,
`-P FORWARD ACCEPT` after a reboot where `ip_forward` was already 1 (Docker only sets DROP when it turns forwarding on),
so **do not rely on the policy**. After a Docker restart the FORWARD order was `DOCKER-USER, DOCKER-FORWARD,
KUBE-ROUTER-FORWARD, ...`; k3s traffic was unaffected.

The other backend (`/etc/docker/daemon.json` `{"firewall-backend":"nftables"}`):
- switched **in place** (`systemctl restart docker`) on a host where the iptables backend had run: **container egress
  FAILED** (`-P FORWARD DROP` left in `ip filter`, Docker's nft table does not accept through it), pod egress OK;
- after a **reboot** with the nftables backend from the start: container egress, pod egress and a published port
  (also reached from a pod) all OK, FORWARD policy ACCEPT. Docker's rules then live in `table ip docker-bridges`, not in `iptables-save`.

**What it changes:** the preflight records `docker info` `Firewall Backend` and `iptables --version` (nf_tables vs
legacy). Both backends coexist with k3s on a fresh boot, but **never switch backend on a live host without a reboot**.
The S5b check must read both views: `iptables-save -t nat` and `nft list ruleset` (Docker's DNAT is invisible to
iptables-save under the nftables backend). Legacy (non-nft) iptables was not tested.

### S11: mount propagation. Result: PASS (failure reproduced; fix verified)

Guest `/` was `shared` (systemd). There, a hostPath pod with `mountPropagation: HostToContainer` and a privileged
`Bidirectional` pod both ran, a host submount showed inside the first, and `docker -v ...:rslave` / `:rshared` worked.
After `mount --make-rprivate /` (the WSL box reads `private` from `findmnt -o TARGET,PROPAGATION /`; ext4 on `/dev/sdd`):

```
HostToContainer: CreateContainerError: path "/srv/hp" is mounted on "/" but it is not a shared or slave mount
Bidirectional:   CreateContainerError: path "/srv/hp" is mounted on "/" but it is not a shared mount
docker -v /srv/hp:/hp:rslave -> Error response from daemon: ... is mounted on / but it is not a shared or slave mount
docker -v /srv/hp:/hp        -> works (default propagation)
```

Core k3s pods (no propagation mounts) kept running; plain hostPath is fine. After `mount --make-rshared /` both pods
and `:rshared` worked again. Not tested: persistence across a WSL restart.

**What it changes:** the preflight reads `findmnt -no PROPAGATION /`; if `private`, the installer installs a oneshot
unit running `mount --make-rshared /` ordered `Before=k3s.service docker.service`, and Bothy modules avoid
`rslave`/`rshared` mounts unless that unit is present.

### S12: kernel support for the network-policy controller. Result: PASS in the guest; WSL host PASS by config only

Guest (Ubuntu kernel, **not evidence about WSL**): `ip_set`, `xt_set`, `nft_compat`, `nf_tables`, `xt_comment`, `xt_mark`,
`overlay`, `vxlan` present; the kube-router controller (v2.11.1-k3s1) started on its iptables path, created ipsets
(`KUBE-DST-*`) and `KUBE-NWPLCY-*` chains, and a `deny-all` ingress NetworkPolicy turned a working pod-to-pod `wget`
into `Connection refused`. No system `ipset` binary was needed.

Host, read-only (`/proc/config.gz`, `/proc/modules`; kernel 6.18.58.1-microsoft-standard-WSL2):

```
CONFIG_IP_SET=m  IP_SET_HASH_IP/NET/IPPORT/IPPORTIP/IPPORTNET/NETPORTNET/NETNET/NETPORT/NETIFACE=m  IP_SET_LIST_SET=m
CONFIG_NETFILTER_XT_SET=m  XT_MATCH_COMMENT/MARK/MULTIPORT/CONNTRACK/ADDRTYPE/PHYSDEV/IPVS=m  XT_TARGET_MASQUERADE/MARK/REDIRECT/CT=m
CONFIG_NF_TABLES=y NFT_COMPAT=m NFT_NAT=y NFT_MASQ=y NF_NAT=y NF_CONNTRACK=y
CONFIG_VXLAN=y VETH=y BRIDGE=m BRIDGE_NETFILTER=m OVERLAY_FS=y CGROUP_BPF=y MEMCG=y CFS_BANDWIDTH=y PSI=y
/proc/modules already lists: ip_set xt_set xt_comment xt_mark xt_multiport xt_conntrack xt_addrtype xt_MASQUERADE nft_compat br_netfilter bridge
/sys/fs/cgroup is cgroup2fs, controllers: cpuset cpu io memory hugetlb pids rdma
```

**What it changes:** the WSL kernel provides everything the controller needs (modules the box already loads), but this is
**not proven by a run** until k3s starts on WSL itself. Preflight: `grep -E 'ip_set|xt_set' /proc/modules` or
`modprobe -n ip_set`, and `cat /sys/fs/cgroup/cgroup.controllers` containing `memory cpu pids`.

### S13: filesystem under the k3s data dir. Result: PASS by read-only check on the host; not exercised

`findmnt -T "$HOME"`: `/` on `/dev/sdd`, **ext4** (`rw,relatime,discard,errors=remount-ro`), not `/mnt/c`. The kernel
supports `9p` and `virtiofs`, so a user could place data on one. **What it changes:** preflight
`findmnt -no FSTYPE -T /var/lib/rancher/k3s` (nearest existing parent) must be `ext4`, `xfs` or `btrfs`; refuse `9p`,
`drvfs`, `fuseblk`, `virtiofs`, `nfs`. No fsync latency benchmark was run.

### Go/no-go delta for k3s

Nothing here blocks k3s and Docker on one host. Hard requirements that came out: Docker modules carry memory limits,
`oom_score_adj` and `restart: unless-stopped`; Bothy's k3s core is Guaranteed QoS and uses no `hostPort`; preflight
checks listeners plus both firewall views plus `/` propagation, and refuses swapless hosts under 4 GiB. Open: who dies
on a real global OOM (the lab wedged), `wsl --shutdown` recovery, minikube, and S7, S8, S14 (Tailscale, not run).
