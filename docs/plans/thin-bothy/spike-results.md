# Spike results

Measured in the VM lab (`lab/lab.sh`, merged in #340). Each result says what it changes in the plans.
S0 and S15 are from a `lab-mini` guest (1 vCPU, 2 GiB); S5b to S13, S5d, S6b and S16 from a `lab-mid` guest (2 vCPU, 4 GiB, S6b with a 2 GiB swapfile); both Ubuntu 24.04 cloud image.

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

## Edge, OOM and admission spikes S5d, S6b, S16 (2026-11-16)

Setup: `lab-mid` again (2 vCPU, 4 GiB, Ubuntu 24.04 guest, kernel 6.8.0-147-generic), a fresh disk per spike (`lab.sh reset`; S5d and S16 shared one guest),
Docker 29.1.3 (`docker.io`, iptables backend), **k3s v1.37.2+k3s1 (Kubernetes v1.37.2+k3s1)**, containerd 2.3.7-k3s1,
Traefik chart 41.6.101 (image 3.7.15), klipper-lb v0.4.17. Guest only; nothing on the live box was touched; no Tailscale. Probes were
busybox `httpd` pods and containers. An "external client" was a separate network namespace behind a veth, routed through the
node, so its packets enter `PREROUTING` on a non-Docker interface (the closest a single VM gets to a tailnet or LAN client).
Node IP in the guest: 10.0.2.15.

### S5d: does ServiceLB use hostPort? Result: PASS (answered: yes, hostPort). The default is **not** safe next to Docker

**What ServiceLB is.** A `type: LoadBalancer` Service on port 8081 produced a DaemonSet `svclb-weblb-<hash>` in `kube-system`
(and `svclb-traefik-<hash>` for the stock Traefik service). Its pod spec (`kubectl get ds -o yaml`, pod `hostNetwork` unset):

```
image: rancher/klipper-lb:v0.4.17      env SRC_PORT=8081 DEST_PORT=8081 DEST_IPS=<service ClusterIP>
ports: - containerPort: 8081  hostPort: 8081  name: lb-tcp-8081  protocol: TCP
securityContext: capabilities add NET_ADMIN        pod securityContext sysctl net.ipv4.ip_forward=1
priorityClassName: system-node-critical            qosClass BestEffort      hostNetwork: <unset>
svclb-traefik: lb-tcp-80 hostPort 80, lb-tcp-443 hostPort 443
```

So it is **hostPort** (the CNI portmap path of S5b), not hostNetwork, and on top of it kube-proxy writes the LoadBalancer-IP
rule (`kubectl get svc`: EXTERNAL-IP 10.0.2.15, the node IP). Views, with the Service on 8081:

```
ss -ltnp            no listener on 8081, 80 or 443 (portmap opens none; kube-proxy opens none)
iptables-save nat   CNI-HOSTPORT-DNAT -p tcp --dports 8081 -> CNI-DN-<h> ... DNAT --to-destination 10.42.0.11:8081
                    KUBE-SERVICES -d 10.0.2.15/32 --dport 8081 "default/weblb loadbalancer IP" -j KUBE-EXT-<h>   (first in PREROUTING and OUTPUT)
nft list ruleset    the same rules in the iptables-nft "ip nat" table (CNI-DN-*, KUBE-SERVICES ... ip daddr 10.0.2.15 tcp dport 8081)
```

**Collision with a Docker container publishing the same port** (`docker run -p 8081:80`; `docker run` exit 0, docker-proxy
binds `0.0.0.0:8081` and `[::]:8081`, the Service keeps working, no event, no error on either side):

| Path to node-IP:8081 | Winner | Why |
|---|---|---|
| `curl localhost` on the host | **DOCKER** | no DNAT for 127.0.0.1: docker-proxy's listener answers |
| `curl 10.0.2.15` on the host | **POD** (svclb) | `KUBE-SERVICES` LB-IP rule is first in OUTPUT, before `DOCKER` |
| a pod to the node IP | **POD** | same |
| a container on docker0 to the node IP or 172.17.0.1 | **POD** | same (and the DOCKER rule has `! -i docker0`) |
| external client (netns on a veth) | **POD** | PREROUTING: `KUBE-SERVICES` first. Counters after 7 requests: `DOCKER ... DNAT` 0 packets, `CNI-DN` 7, `KUBE-SERVICES` LB rule 4 |

Differences from S5b (a bare hostPort pod): there Docker won the host path and the pod lost only from docker0; with ServiceLB
**the pod wins every path to the node IP, so a Docker module is reachable only on localhost.** `systemctl restart docker`
re-inserted `DOCKER` after `CNI-HOSTPORT-DNAT` (PREROUTING order `KUBE-SERVICES, CNI-HOSTPORT-DNAT, DOCKER`) and changed nothing,
because the `KUBE-SERVICES` jump comes first either way. Reverse order (Docker on 8082 first, then the LoadBalancer Service):
same table, the svclb pod became Running without complaint. Stopping the container hands everything to the pod.
Stock install, nothing deployed by us: **Docker on host port 80** (`docker run -p 80:80`) exits 0, localhost answers from Docker,
the external client gets Traefik's `404 page not found`. On this box a stock `get.k3s.io` install would therefore take over
node-IP ports 80 and 443 for tailnet clients away from the Docker Traefik and portal, silently (inferred from the Docker-on-80 test; the live box was not touched).

**Alternatives** (servicelb disabled with `/etc/rancher/k3s/config.yaml` `disable: [servicelb]`; the svclb DaemonSets disappeared
after the k3s restart):

(b) **Traefik as NodePort 30080/30443** (`HelmChartConfig` `ports.web.nodePort`). Quirk, not root-caused: the Helm upgrade
(revision 2) applied the node ports but the live Service stayed `type: LoadBalancer` with a stale `status.loadBalancer.ingress` of
10.0.2.15, so kube-proxy kept the LB-IP rules and :80 still answered; after `kubectl patch svc -p '{"spec":{"type":"NodePort"}}'` :80
was refused, as it should be. Then: `ss` shows **no listener** on 30080 (kube-proxy holds nothing). `docker run -p 30080:80`
succeeds (exit 0, docker-proxy binds). Winners: localhost -> Docker; node IP, external client, docker0 -> **Traefik**
(`KUBE-NODEPORTS` hangs off `KUBE-SERVICES`, which is first); unchanged after `systemctl restart docker`; reverse order (Docker
on 30081, then a NodePort Service pinned to 30081) identical. Outside the range there is no collision: with the Service on a
NodePort, `docker run -p 80:80` was reachable from every path including the external client. So NodePort is a **silent shadow
inside 30000-32767 and clean outside it**; the range is below the ephemeral range 32768-60999 here. It cannot publish :80 or :443
unless the apiserver `--service-node-port-range` is widened, which brings the shadowing to those ports.

(a) **Traefik as a hostNetwork pod** (`HelmChartConfig`: `hostNetwork: true`, `service.enabled: false`, `ports.web.port: 80`,
`ports.websecure.port: 443`, `runAsUser: 0` with `NET_BIND_SERVICE` added; nothing was tried with a non-root user). `ss -ltnp`:
`traefik` on `*:80 *:443 *:9100 *:8080`, a **real listener**; `iptables-save -t nat` has no `CNI-DN` and no rule for 80/443.
- `docker run -p 80:80` while Traefik holds 80: **fails**, exit 125, `driver failed programming external connectivity ... failed to bind
  host port ... address already in use` (the container is left in state Created).
- Reverse (Docker has 80, then Traefik starts): Traefik `CrashLoopBackOff`, log
  `listen tcp :80: bind: address already in use`; it came up on its own within about 2 minutes of the port being released
  (back-off). The external client got the Docker body in the meantime.
- Side findings. (1) hostNetwork also opens Traefik's `8080` (`/ping` 200) and `9100` (`/metrics` 200) on every interface;
  both answered the external client. (2) With the chart's default `RollingUpdate` (`maxSurge 1, maxUnavailable 0`) a rollout
  **deadlocks**: the new pod stays `Pending` (the scheduler sees host-port 80/443 taken by the old pod) and the old one is
  never terminated; with `maxSurge: 0, maxUnavailable: 1` the rollout finished in seconds.
- **Admission needed:** hostNetwork, root and an added capability violate Pod Security `baseline` and `restricted`
  (S16: `host namespaces (hostNetwork=true)`). The edge namespace must be exempt (`kube-system` in the admission config of S16, or
  a namespace labelled `pod-security.kubernetes.io/enforce=privileged`); on stock k3s (default level `privileged`) it needs nothing.

**Verdict.** Default ServiceLB: **unsafe** next to Docker modules (hostPort plus an LB-IP rule that beats `DOCKER`, silent, and it
claims 80/443 on install). NodePort: safe only if 30000-32767 is reserved in the same port registry as Docker modules (a Docker
port inside it is silently dead from the network), and it cannot serve :80/:443 without widening that range. **hostNetwork
Traefik with `--disable servicelb` is the only option where a collision is a loud failure on both sides**, and it is visible to the
S5b preflight (`ss -ltnp`). **Recommendation: `disable: [servicelb]` at install, Traefik hostNetwork in an exempt edge
namespace on ports the registry hands out, `maxSurge: 0`, admin and metrics entrypoints bound to loopback or disabled (the
last two are advice, not tested).** NodePort is the fallback where hostNetwork is unwanted, with the range reserved. What it
changes: `architecture.md` s5 (ASSUMPTION K) is confirmed as a risk; the installer writes the `config.yaml` above before
the first k3s start. Not tested: UDP, IPv6 (QEMU user networking has it off), a second node, Tailscale.

### S6b: global OOM on a guest with swap. Result: PASS (victims measured, guest survived); the S6 wedge was not reproduced and its cause is not isolated

Guest: `lab-mid`, 4 GiB, **2 GiB swapfile** (`fallocate`, `mkswap`, `swapon /swapfile`, priority -2), `vm.swappiness = 60` (the
Ubuntu default, unchanged), `vm.overcommit_memory = 1`. The swapfile is a file on the guest's qcow2 disk: it adds no host RAM, the
VM scope `lab.sh` creates keeps `MemoryMax 4992M`, `MemorySwapMax=0` and `CPUQuota 200%`, so a thrash costs host disk I/O
(run 1 wrote 533 175 pages, about 2.0 GiB, to swap) and at most two host cores, and cannot take the host's memory. Two changes
against S6, both to read the result: swap, and the guest's **console log level cut** (`kernel.printk = 3 4 1 3`, so the OOM
report is not written to the serial file) with a persistent journal. Stock k3s pods present (CoreDNS, Traefik, svclb, metrics-server,
local-path) plus one Guaranteed test pod.

Hog: `docker run -d --oom-score-adj <A> python:3.12-alpine` appending 64 MiB `bytearray`s every 0.1 s up to 9.4 GiB (150 steps), no `--memory`
limit (so unlimited, not the S6 `sh` allocator). Driver on the host: `lab.sh ssh` probe every 4 s, hard cap 240 s, `lab.sh down`
if ssh was dead for more than 180 s. **The watchdog never fired** (longest ssh silence about 40 s).

| Run | A | Killed by the kernel (in order) | Core daemons and Guaranteed pod | ssh from the host | Pods back |
|---|---|---|---|---|---|
| 1 | 0 | `traefik` (adj 1000, anon 17.8 MB), `coredns` (adj 983, 11.8 MB), then the hog (adj 0, 3.6 GB), at +81 s | k3s-server, dockerd, containerd, sshd, `guar`: **alive**, 0 restarts | silent between +43 s and +83 s, load 20 | Traefik and CoreDNS `restartCount 1` (`OOMKilled`, exit 137), Ready 47 s after the kill; metrics-server restarted once (exit 0, probe-driven) |
| 2 (repeat) | 0 | `coredns` (adj 983), then the hog (3.2 GB), at +62 s | same | silent about 34 s (+4 s to +38 s) | Traefik and metrics-server restarted by probe failures (not in the OOM list); CoreDNS killed |
| 3 | 500 | the hog only (adj 500, 3.5 GB), at +36 s | same; `oom_kill` under `kubepods.slice` unchanged | **never lost**, one slow probe of 11 s | Traefik, CoreDNS, metrics-server flapped Unready on probe timeouts, no restart |

Per-cgroup `memory.events` after run 1 (all zero before): `kubepods.slice oom_kill 4 oom_group_kill 2` (besteffort 2/1,
burstable 2/1), `system.slice oom_kill 1` (the hog's docker scope); `system.slice/k3s.service`, `docker.service`,
`containerd.service`, `ssh.service` all `oom_kill 0`. After run 3 `kubepods.slice` was still 4/2: only `system.slice` grew. All
three are global OOMs (`global_oom`, `CONSTRAINT_NONE`), `docker inspect` of the hog: `OOMKilled=true`, exit 137.
The kernel scores a task as (RSS + swapped pages) * 1000 / (RAM + swap pages) + adj. With 5.9 GiB of RAM plus swap, a 3.3 GiB hog scores
about 560 at adj 0 (my arithmetic, not read from `oom_score`) against about 1000 for a BestEffort Traefik, and about 1060 at adj 500:
**an unlimited Docker container at adj 0 is not the first victim; the stock Traefik and CoreDNS are collateral, and at adj 500 the hog
wins by a narrow margin.** Run 1 and 2 differ in who else died, so the ordering among the stock pods is
not deterministic; the finding is the set (Traefik, CoreDNS) not the order.

One unplanned run (n=1): a mistaken `swapon -a` left the guest **without** swap (it only enables fstab entries) for the start of
run 3's first attempt. A hog at adj 500 was killed after 9 s, only it, and the guest never stopped answering ssh. So the S6
wedge (more than 8 minutes, qemu at 100% CPU) did not recur with or without swap; the console level is the other thing that changed,
and the run was too small to say which mattered. Not isolated.

**`oom_score_adj` by pod (measured in `/proc/<pid>/oom_score_adj`, per container process):**

| Pod | QoS | adj | Note |
|---|---|---|---|
| `guar` (cpu and memory requests equal limits) | **Guaranteed** | **-997** | survived all three runs, 0 restarts |
| test pod, request 16 Mi | Burstable | 996 | `1000 - 1000 * request / 3915 MiB` |
| test pod, no resources | BestEffort | 1000 | |
| CoreDNS (stock) | Burstable | 983 | killed in runs 1 and 2 |
| Traefik (stock) | BestEffort | 1000 | `priorityClassName system-cluster-critical` does **not** protect it; killed in run 1 |
| metrics-server, local-path-provisioner, svclb-* (stock) | Burstable / BestEffort | -997 | `system-node-critical`: treated as critical whatever the QoS |

Others: sandbox `pause` -998, k3s-server -999, Docker's containerd -999, dockerd -500, sshd -1000, journald -250,
containerd-shim 1, Docker containers 0 by default. `kubepods.slice/memory.max` was 4106088448 (the whole guest) and every
`memory.low` and `memory.min` 0: the kubelet reserves nothing.

**What it changes:** (1) the victim question from S6 is answered for a guest with swap: the kernel kills stock BestEffort and
Burstable pods, and a Guaranteed pod and the k3s, Docker and sshd daemons survive. A Docker module needs a positive adj
(500 or more was enough here) and a limit; an unlimited one at adj 0 costs Traefik and CoreDNS a restart each (about 47 s to
Ready) and the box about 35 to 40 s of ssh silence. (2) Bothy's core pods must be **Guaranteed** (-997, measured) or
`system-node-critical`; `system-cluster-critical` is not enough. (3) Swap kept the guest reachable and turned an instant kill
into a 30 to 80 s thrash (SwapFree reached 0 to 6 MiB, load 12 to 20): recommended, not required. Still not measured: the
cause of the S6 wedge, any WSL kernel, adj values above 500, `swappiness` other than 60, and more than two runs.

### S16: Pod Security Admission plus ValidatingAdmissionPolicy on the bundled apiserver. Result: PASS (both work; needs no extra flags beyond the config file)

Tested on k3s v1.37.2+k3s1 (Kubernetes v1.37.2). **Stock first:** the default level is `privileged`: a pod with `hostPort` in a fresh namespace was
created with no warning. `kubectl api-resources` lists `ValidatingAdmissionPolicy`, `...Binding` and `MutatingAdmissionPolicy`
at `admissionregistration.k8s.io/v1` with no flags. Configuration, in `/etc/rancher/k3s/config.yaml`:

```yaml
kube-apiserver-arg:
  - admission-control-config-file=/etc/rancher/k3s/psa.yaml
```
```yaml
# /etc/rancher/k3s/psa.yaml (PodSecurity plugin; audit and warn are restricted too)
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
- name: PodSecurity
  configuration:
    apiVersion: pod-security.admission.config.k8s.io/v1
    kind: PodSecurityConfiguration
    defaults: {enforce: restricted, enforce-version: latest, audit: restricted, audit-version: latest, warn: restricted, warn-version: latest}
    exemptions: {usernames: [], runtimeClasses: [], namespaces: [kube-system]}
```

After `systemctl restart k3s` (readyz ok, stock pods and Traefik unaffected) one pod per case, created with `kubectl apply`:

| Pod | `bothy-mod` (no labels: the default, restricted) | `bb-baseline` (label enforce=baseline) | `kube-system` (exempt) | `edge-priv` (label enforce=privileged) |
|---|---|---|---|---|
| `hostPort` | **refused** | **refused** | created | created, with a restricted warning (a second one stayed Pending only on the port clash) |
| `hostNetwork: true` | **refused** | **refused** | created | created |
| `hostPath` volume | **refused** | **refused** | created | created |
| `privileged: true` | **refused** | **refused** | created | created |
| compliant (non-root, drop ALL, seccomp) | created | created | created | created |

**PSA baseline does refuse `hostPort`** (verified, not assumed). Exact errors, namespace `bb-baseline`:

```
Error from server (Forbidden): ... pods "t-hostport" is forbidden: violates PodSecurity "baseline:latest": hostPort (container "c" uses hostPort 18085)
... violates PodSecurity "baseline:latest": host namespaces (hostNetwork=true)
... violates PodSecurity "baseline:latest": hostPath volumes (volume "h")
... violates PodSecurity "baseline:latest": privileged (container "c" must not set securityContext.privileged=true)
```
and in `bothy-mod` the same four under `restricted:latest` (with the extra `allowPrivilegeEscalation`, `capabilities`, `runAsNonRoot`
and `seccompProfile` clauses, which the bare test pod also violates). The exempt namespace ran all five pods, and the hostNetwork
Traefik of S5d kept running there. A second hostPort pod on the same port in `edge-priv` stayed `Pending` (the scheduler's
host-port check).

**Namespace labels override the default** (`edge-priv`, and `bothy-mod` after `kubectl label ns bothy-mod
pod-security.kubernetes.io/enforce=privileged`: a privileged pod was created). So PSA defaults stop mistakes, not someone who can edit
Namespaces; that is the "nothing but the core operator may change namespace labels" rule of `security-model.md` 6.2, still untested.

**ValidatingAdmissionPolicy to refuse `hostPort` specifically**, immune to that relabel because the binding selects by the immutable
`kubernetes.io/metadata.name`:

```yaml
spec: {failurePolicy: Fail, matchConstraints: {resourceRules: [{apiGroups: [""], apiVersions: [v1], operations: [CREATE, UPDATE], resources: [pods]}]},
  variables: [{name: cs, expression: "object.spec.containers + (has(object.spec.initContainers) ? object.spec.initContainers : [])"}],
  validations: [{expression: "variables.cs.all(c, !has(c.ports) || c.ports.all(p, !has(p.hostPort) || p.hostPort == 0))", reason: Forbidden,
    message: "hostPort is refused outside kube-system: publish through a Docker module port or the Traefik edge"}]}
binding: validationActions [Deny, Audit]; matchResources.namespaceSelector matchExpressions {key: kubernetes.io/metadata.name, operator: NotIn, values: [kube-system]}
```

Served on the first apply (`status.typeChecking {}`, no warnings). Results: `edge-priv` (PSA privileged): `pods "vap-hp" is forbidden:
ValidatingAdmissionPolicy 'bothy-no-hostport' with binding 'bothy-no-hostport' denied request: hostPort is refused outside kube-system: publish
through a Docker module port or the Traefik edge`. `kube-system`: hostPort pod created. In `bothy-mod` relabelled privileged: the privileged pod
was created and the **hostPort pod refused** by the policy. A **Deployment** with a hostPort is accepted by the API (`deployment.apps created`, 0/1); the
denial appears when the ReplicaSet creates the pod (`FailedCreate ... denied request: hostPort is refused ...` in `kubectl describe rs` and events), so a controller-made
pod fails later and quietly. After a k3s restart both objects and the PSA config were still in force.

**What it changes:** `security-model.md` 6.2's ASSUMPTION (the bundled apiserver serves VAP with no extra flags) is **settled for
v1.37.2+k3s1**; the installer writes the two files above before first start. Use PSA for the four host-level cases (it already refuses all four
in `baseline`) and the VAP for what PSA cannot say or what a relabel could undo; put the Job and Namespace rules of 6.2 in further
policies. Not tested: the 6.2 Job and Namespace-label policies, ephemeral containers, `MutatingAdmissionPolicy`, the config surviving a k3s upgrade, a `HelmChart`
installed into a non-exempt namespace, and k3s versions other than this one.

## Follow-up spikes these results raise (2026-11-16; S5d, S6b and S16 have since been run, see above)

| ID | Question | Why |
|---|---|---|
| S5d | Do k3s ServiceLB's svclb pods publish through `hostPort`? | **Run: yes, and worse than S5b; hostNetwork Traefik recommended.** `architecture.md` s5 (ASSUMPTION K) |
| S6b | Global OOM on a guest with swap: who dies? | **Run: Traefik and CoreDNS die before an unlimited adj-0 hog; adj 500 kills only the hog; the guest survived.** The S6 wedge did not recur |
| S16 | Does the bundled apiserver serve `ValidatingAdmissionPolicy`, and are the bad cases rejected? | **Run: yes (v1.37.2+k3s1); PSA and VAP both work.** `security-model.md` 6.2 |
| S17 | A real Bothy core (Guaranteed, no hostPort) idle memory on k3s, and a `lab-std` run to confirm the 4 GiB floor | S0 left this open; every core figure is still E |
| S12b | k3s actually starting on a WSL kernel (a WSL host that is not the live box) | S12 and S13 were config and filesystem reads only |
