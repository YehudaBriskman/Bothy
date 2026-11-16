# Review findings (2026-11-16) and what they change

Seven independent read-only reviews of this plan, each from a different lens:
k3s platform, DevOps/SRE, systems architect, security, network/WSL2/Tailscale,
fact-checker, and a solo-maintainer pragmatist. **Provenance matters:** the
fact-checker and network reviewers ran commands against the real box and repo; the
k3s reviewer worked from memory of the docs (no web search, nothing run on a live
cluster); the security reviewer read only the plan files. Claims below are marked
**V** (verified against the repo or box by a reviewer), **K** (known k3s/Kubernetes
behaviour, not re-verified here) or **I** (inference). Anything marked K or I is to be
confirmed in the VM lab before the plan relies on it.

## 1. The meta-finding

The plan was written in layers and **never reconciled**. `hybrid-runtime.md` was
written last and overrides `architecture.md`, but `security-model.md`,
`updates-and-rollback.md`, `modes-and-modules.md`, `customization.md`,
`footprint-and-budgets.md`, `testing-and-ci.md` and (until today) `migration.md`
still described an "everything in k3s" world. Three reviewers found this
independently. **Status:** migration Phase 5 and the factual errors are fixed in
place (section 2); the rest is queued (section 4) and **waits on the decision in
section 5**, because how security and updates are rewritten depends on whether k3s
passes its go/no-go.

## 2. Fixed in place (my errors)

| Finding | Fix |
|---|---|
| Sum of compose limits "5.9 GB" **(V)** | 5088 MiB; corrected in footprint and resource-management |
| "70%" / "0.8 GB monitoring" **(V)** | 78% / about 0.9 GB (57%) |
| Traefik "85 MiB, access-log buffering" **(V)** | 64-85 across samples; cause unverified |
| Self-contradictory "two limits are lies" sentence | rewritten |
| "Three roles viewer/operator/admin" **(V)** | the roles are viewer, editor, operator (+ an unused `shell`); no `admin` |
| "`oci-free` already does k3s bootstrap" **(V)** | it does not; only its Tailscale install is reusable |
| "about 40 published ports" **(V)** | 25 distinct (23 in `just urls`) |
| `install.yml` "nightly" **(V)** | it has no schedule; `upgrade.yml` and `elsewhere.yml` are nightly |
| `oci-free` CI "verifies idle reclaim" **(V)** | only documented; its CI is `ci.yml` and `secret-scan.yml` |
| `.wslconfig` as the memory source **(V)** | `free` already reads the 24 GB cap; use MemTotal/MemAvailable/cgroup and count swap (6143/6144 MB used) |
| "bind to the tailnet address via `--node-ip`" **(K/I)** | marked **open** (S8); no tailnet-only claim until it passes |
| Dropping the cAdvisor container **(K)** | only valid in mini; Docker modules need it kept |
| migration Phase 5 still moved `sso`/`postgres`/`logs`/`dashboards` | rewritten to k3s-runtime modules only |

## 3. New spikes (add to the Phase 0 list)

| ID | Question | Source |
|---|---|---|
| S5b | A k3s hostPort that duplicates a Docker port never fails `bind()`; it adds a second DNAT rule and the first wins silently. Preflight must check `ss -ltnH` **and** the nat DNAT rules; acceptance is a before/after diff of `iptables-save -t nat` for the 32 live containers | network **(V reasoning)** |
| S5c | Coexistence beyond "containers still run": Docker daemon restart with k3s up, `wsl --shutdown` recovery, minikube coexistence (CIDRs 10.42/16 and 10.43/16 do not overlap current nets **(V)**), k3s writes its own kubeconfig and never touches `~/.kube/config` | devops, network |
| S6 | Core survives a Docker module exceeding its limit, asserted via `memory.events` in both cgroups; `oom_score_adj` alone is not proof | network, k3s |
| S7 | Cold-boot ordering: tailscaled, k3s, docker, keepalive | network |
| S8 | Stable node IP and tailnet-only exposure (dummy interface plus host firewall on `tailscale0`, or hostNetwork Traefik with `ip_nonlocal_bind` and `After=tailscaled`); includes tailscaled restart while listeners are bound | network, k3s |
| S9 | `k3s-killall` and uninstall leave Docker's iptables and nat untouched | network |
| S10 | Docker restart does not break pod egress; pin the Docker firewall backend | network |
| S11 | Mount propagation: `/` is `private` here **(V)**, so pods using `rslave`/`rshared` hostPath mounts fail; installer must run `mount --make-rshared /` via a unit | network |
| S12 | The WSL2 kernel supports what k3s's network-policy controller needs (ipset/xt modules) | k3s |
| S13 | k3s data dir is on ext4, not `/mnt/c` (kine/SQLite fsync on 9p) | k3s |
| S14 | Tailscale SSH and sshd coexist on one node; the ACL `ssh` rule for tags | network, security |

## 4. Rewrite queue (**done 2026-11-16**, see below; the table is kept as the record of what was asked)

**Status 2026-11-16:** the owner's decisions (k3s-first for hosts of at least 4 GiB, hybrid runtime, Compose
retained) removed the blocking question, and the lab produced S0, S5b to S13 and S15. Every row below
was applied to the plan documents, with a "Changed 2026-11-16" note at the end of each file naming the
spike or decision. Rows that remain **proposals without a run** are marked ASSUMPTION in those files:
the admission policy, `bothy-hostd`, the edge publication choice, the cross-runtime forward-auth hop,
and the two-clone consistency of the updater. Disagreements between documents that were resolved
are listed in `README.md` (go/no-go section).

| File | What must change | Reviewers |
|---|---|---|
| `security-model.md`, `updates-and-rollback.md` | rewrite as **two executors** (k3s Job plus `bothy-hostd`); define hostd's request schema, spool hardening (distinct UID, `O_NOFOLLOW`, regular-file/nlink checks, claim by rename, parse once, never build argv from text), and name the single `hostPath` exemption; delete the "no Docker socket / deleted" rows | architect, security |
| same | **RBAC cannot constrain what a `create` contains**: `bothy-api` creating Jobs can mount any Secret including the master key. Needs a ValidatingAdmissionPolicy (pinned image, fixed command, allow-listed SA, no Secret mounts) and the master key in its own namespace, or an API-writes-a-CR design. "Impersonates the Role" is the wrong model: the Job runs as a bound SA, and Helm needs Secret access in module namespaces; Roles come from the platform allow-list, never the module | security **(I)**, k3s **(K)** |
| same | The core operator owns Namespace, ResourceQuota, LimitRange and NetworkPolicy; module charts may not create them (else a module can delete its own sandbox) | k3s **(K)** |
| same | Split the updater's own RBAC and Job template into a separate release, with a host-side `bothy rollback` that needs no in-cluster rights; per-module lock and a stuck-release (`pending-upgrade`) reaper; `--atomic` does not revert CRDs, PVC contents or migrations, so charts declare `migrations = reversible \| forward-only` and forward-only ones take a PVC copy first | devops, k3s |
| same | k3s upgrades: host step primary (stop, copy datastore, upgrade, start, verify); drop the system-upgrade-controller | devops, k3s |
| same | Supply chain: signed tags/commits, a 72 h cooldown before `auto` applies, image signature checks; installer hash published out of band | security |
| `architecture.md` s5, `hybrid-runtime.md` | add **Edge** (who owns `:80`: k3s Traefik vs Docker Traefik; how a k3s router reaches a Docker backend; which gate protects a Docker service), **Discovery** (module catalog is the truth; two adapters; how a pod reaches host state without a hostNetwork/hostPath proxy that leaks `docker inspect` env), and **State ownership** (settings, secrets, update history, backups, module declarations: owner and location) | architect, security |
| `architecture.md` s5 | k3s Traefik is a packaged HelmChart: configure via `HelmChartConfig` in `kube-system` or `--disable traefik` and run our own pinned release; ServiceLB is required for the LoadBalancer Service and is one DaemonSet pod per Service, not per port; cross-namespace middlewares need `allowCrossNamespace` or a per-namespace copy (as oci-free does) | k3s **(K)** |
| `architecture.md` s4 | "one declaration generates Compose and Helm" is over-promised: the declaration holds metadata (cost, fields, requires, health, runtime); each runtime artifact is hand-written and CI-validated against it | architect |
| `resource-management.md` | cross-runtime gate is **advisory** for the Docker half (it can know declared sums and a periodic `docker stats` sample, not enforcement); QoS wording: "Guaranteed" needs request = limit for CPU too, eviction ranks by usage over requests, and priority classes do not affect the kernel OOM killer; disk budgets are advisory (`local-path` does not enforce PVC size); measure idle memory as cgroup/PSS, not `free` | k3s, architect |
| `modes-and-modules.md` | add a `runtime` column; `postgres` is Docker and cannot sit in a k3s mode set; add the `network` module; auth adapter interface (forward-auth endpoint with `X-Forwarded-User/Role`) and which runtime serves it | architect |
| `modes-and-modules.md`, `install-and-bootstrap.md` | `login` needs a threat spec (argon2id parameters, rate limit/lockout, cookie flags, CSRF/Origin checks, session revocation on reset); the one-time password must not be emitted on a non-TTY (cloud-init logs are world-readable): use a short-lived claim token via `bothy admin init`, or a user-supplied hash; `bothy admin reset` must not mean "anyone who reads the kubeconfig"; refuse or loudly warn on plain-HTTP LAN reach | security |
| `install-and-bootstrap.md` | k3s apiserver (6443) and kubelet (10250) bind all interfaces: `--bind-address`/`--advertise-address` plus a host firewall, kubeconfig root-only (0600), listener check in verify; installer and lab preflight list (below); a disaster-recovery section (recovery bundle forced at install, `bothy restore` tested) | security, devops, network |
| `backups` placement | **the k3s `backups` module cannot back up Docker data** (needs socket/volumes/host files). Keep the host `scripts/backup.sh` and `stacks-backup.timer` for Docker data; add a k3s-state backup (host-side; SQLite is a consistent file copy, there is no etcd snapshot); require an **off-node target**; the master key lives in a **host file outside the datastore** (a cluster Secret cannot be "excluded from backups") | devops, k3s |
| observability | nothing alerts if k3s itself is down and the dead-man heartbeat has no named off-box receiver: add a host watchdog on `k3s.service` and at least one off-cluster notification channel in mini | devops |
| `customization.md` | layer 5 denylist on values is bypassable (`extraVolumes`, `securityContext`, `command`, image overrides): lint the **rendered** manifests against an allow-list and enforce in-cluster; layer 6 modules need reserved ids, prefix enforcement, rejected cluster-scoped kinds and NetworkPolicy/quota/namespace-label changes | security |
| `testing-and-ci.md` | say which layers are k3d and which need a full VM (hosted runners have no systemd-in-container for the real installer); arm64 weekly non-blocking; hostd and the Docker executor need tests; WSL-specific checks need a schedule or self-hosted runner; every pinned digest must be a multi-arch manifest-list digest | devops, k3s |
| `vm-lab-and-connectivity.md` A | gate on `MemAvailable` minus a reserve (not `MemTotal`); run QEMU under `systemd-run --user` with `MemoryMax`, `MemorySwapMax=0`, `CPUQuota` and a raised `oom_score_adj`; refuse to start when swap use is above about 50%; bind SLIRP `hostfwd` to `127.0.0.1` on a dynamic port; Tailscale behind SLIRP is double NAT, so S1 numbers are not representative there; `usermod -aG kvm` needs a new session (use `sg kvm -c`; `wsl --shutdown` would kill the live containers); package list `qemu-system-x86`, `qemu-utils`, `cloud-image-utils`; ephemeral nodes are removed after a delay, a single-use key breaks `lab-reset`, and the key sits in the cloud-init seed so delete it after join | network |
| `vm-lab-and-connectivity.md` B | pass `--accept-dns=false` explicitly (the default is true) and assert `CorpDNS=false`; re-running `tailscale up` with different flags errors, so use `tailscale set`; print a least-privilege ACL with named users; the default tailnet ACL is allow-all, so "tailnet only" is not restricted; the apply-with-timer revert must be a host unit and confirmation must come from the new path | network, security |
| day-2 checklist (new) | k3s client-cert rotation, containerd image GC and DiskPressure (it evicts core first), Helm `--history-max`, audit-log growth, chart bumps | devops |
| runbooks (new) | `runbook-cluster-down` (k3s dead, Docker up), monthly automated restore verification into a scratch VM, and a `preflight-coexist` check run after any Docker/WSL/k3s upgrade | devops |

**Installer and lab preflight** (from the network review): not root and `sudo -n`
works; systemd is PID 1; cgroup v2 with cpu/memory/pids/cpuset; modules overlay,
br_netfilter, vxlan, nft_nat, `/dev/net/tun`, `/dev/kmsg`; `/` mount propagation;
iptables backend and Docker's FORWARD policy recorded; `iptables-save` and `nft list
ruleset` snapshots for a post-install diff; port inventory including NAT DNAT;
6443/10250/80/443 and requested ports free; CIDR overlap check for 10.42/16 and
10.43/16; MemAvailable, swap and cgroup cap fit the profile; disk space and ext4
(not `/mnt/c`); `/dev/kvm` rw for the current user; tailscaled running and not
version-skewed (rule 11); `CorpDNS`/`RunSSH`/exit-node state recorded; no existing
kubeconfig touched.

**Security invariants to add to CI:** (1) a live admission test that a privileged
pod, a hostPath pod, and a Job created as the api ServiceAccount with a foreign image,
SA or Secret mount are all rejected; (2) `kubectl auth can-i --list` for every
ServiceAccount equals a committed snapshot with no `impersonate`, `escalate` or
`bind`; (3) a listener, route and secret scan on a fresh install (6443 and 10250
unreachable from the LAN, no secret in GETs, `helm get values`, Job specs, logs or
cloud-init output, and no first-run credential in a world-readable file).

## 5. The decision this review forces (for the owner)

**Outcome 2026-11-16:** the owner kept k3s-first (hosts of at least 4 GiB) with Compose retained below
that and as the D7 fallback; this section's ordering advice is **not adopted as an ordering**, but the
steps that do not need k3s (1 to 3 below) remain independently valuable and may proceed in parallel
with the lab work. The go/no-go gate it asked for is now in `README.md`.

Two reviewers (pragmatist, architect) independently recommend **inverting the
priority**: make the **module model, settings store (#317), first-run login (#319),
Settings -> Modules (#321), no-personal-data work (#323-#326) and an advisory budget**
the primary track **on Compose**, and treat k3s as a measured spike with a written
go/no-go gate after the VM lab, rather than a headline decision. Their reasoning:
none of your stated user-visible goals needs k3s; the plan is larger than every prior
plan in the repo combined (the pragmatist estimates 70-110 PRs, 5-8 months at the
repo's real non-Dependabot pace, with a bursty history); and the hybrid decision
removed only the riskiest moves while adding a second executor and an unproven
cross-runtime gate.

**This conflicts with D1/D3, which you decided.** It is not mine to flip. What I
recommend, as a **way to honour both**: keep k3s as your direction, but **order the
work so the first deliverables do not depend on it**, and put a **hard go/no-go gate
after the VM lab**:

| Step | Needs k3s? | Delivers |
|---|---|---|
| 1. Small issues as filed: #336, #337, #338, #306-#309 | no | quick wins, no dependency on this plan |
| 2. Privacy and defaults: #323, #324, decide #325/#326 | no | needed for any public user (the plan did not mention #325/#326) |
| 3. Settings store (#317), first-run password (#319), module declaration as **metadata + enable flag** (#320), Settings -> Modules (#321), advisory budget | no | mini/standard/full as Compose profile sets, chosen from the web |
| 4. VM lab and spikes S0, S5-S14 | builds the lab | **go/no-go write-up** |
| 5. k3s core and the k3s half of the updater | yes | only if step 4 says go |

Steps 1-3 are the D7 fallback you already accepted; doing them first means **no work
is wasted whichever way step 4 goes**. The pragmatist also notes mini as specified is
a login screen and an empty Overview; moving `files` into mini (the reading surface
is the main product) and naming modes by outcome rather than size are worth taking.

## 6. Cut or defer candidates (reviewers' list; not yet accepted)

Third-party modules (layer 6), the raw Helm values editor (layer 5), resource
profiles (layer 4), the MCP surface and scoped tokens, per-user preferences
(#145/#157), the Module CRD, arm64 CI and the OCI target (D4), the SSH reach choice,
Tempo as a module, cross-runtime budget **enforcement**, and `parity-<module>.mjs`
checks. The k3s-first headline in the README would move behind the gate.
