# VM lab and install-time connectivity

Two connected things the owner asked for on 2026-11-16: (A) a **real VM** to develop
and prove the install on **without risking this box**, and (B) an install that, on a
VM, offers to **link to Tailscale or SSH** as part of the process.

## A. The VM lab

### A.1 Why a VM, and why not another WSL distro

All WSL2 distros share **one kernel and one network namespace** with this one, so
k3s and Docker fighting over iptables in a second distro would still hit the 32 live
containers. A real VM has its **own kernel and its own iptables**. That isolation is
the entire point (risk R1 in `risks-and-open-questions.md`).

**Status 2026-11-16:** the lab exists (`lab/lab.sh`, #340) and has produced S0, S15 and S5b to
S13. It already implements several review items: each VM runs in a `systemd-run --user` scope with
`MemoryMax`, `MemoryHigh` at 95%, `MemorySwapMax=0` and `CPUQuota`; host forwards bind **127.0.0.1**
only; swap use is **shown, not gated** (a gate would refuse everything on a host whose swap is
already full, so the review's "refuse above about 50%" is resolved as display-only). Profiles:
`lab-mini` (1 vCPU, 2 GiB), **`lab-mid` (2 vCPU, 4 GiB, added for S5b-S13)** and `lab-std`;
`lab-oci` is deliberately not offered until `lab-mini` is measured.

**The lab is not a sandbox (S15):** a guest root can delete cloud-init's rule and reach the host's
loopback (HTTP 302 measured). It is for our own installer and k3s tests, never untrusted code.

**Gap that blocks the go/no-go:** the guests are **swapless**. S6's global OOM must be re-measured on a
guest **with swap** (add a swap-enabled variant), and ideally with the guest serial console off, because
part of the 8-minute wedge may be the console.

### A.2 What this box can do (measured 2026-11-16)

| Fact | Value |
|---|---|
| `/dev/kvm` | present (root:kvm), CPU virtualization flags: 20 |
| `.wslconfig` | `nestedVirtualization=true`, 24 GB, 10 CPUs |
| qemu / multipass / lima / libvirt | **none installed** |
| Disk | 775 GB free |
| Tailnet peers | this box, iPhone, `oci-free-arm`, Windows host, thinkpad |

So a KVM VM is possible once `qemu-system-x86` and image tooling are installed
(needs `sudo apt`, and the user in the `kvm` group). Nested virtualization costs some
speed; fine for this workload.

### A.3 Options

| Option | For | Against |
|---|---|---|
| **QEMU/KVM + Ubuntu 24.04 cloud image + cloud-init** | the same cloud-init path OCI uses, so we test the real bootstrap; scriptable; qcow2 backing files make reset instant | a script of our own to maintain |
| Multipass | one command | needs snap and a hypervisor backend; opaque; less cloud-init control |
| Lima | nice UX | aimed at macOS; more moving parts on WSL |
| libvirt/virt-manager | full-featured | heavy for a single disposable VM |
| The real OCI VM (`oci-free-arm`) | genuine ARM, genuine target | **it runs the portfolio site**; never a test bed. A *second* free instance may exceed the free envelope. |

**Recommendation: QEMU/KVM + cloud-init, scripted under `lab/`.**

### A.4 Design of the lab

- **Image:** Ubuntu 24.04 cloud image, one read-only **base**; each VM is a qcow2
  **overlay**, so "reset to clean" is deleting the overlay.
- **Profiles** (so budgets are tested at realistic sizes):

| Profile | vCPU | RAM | Purpose |
|---|---|---|---|
| `lab-mini` | 1 | 2 GB | does mini fit with headroom? |
| `lab-oci` | 2 | 12 GB (cap ~8 GB here) | the OCI A1 shape |
| `lab-std` | 4 | 6 GB | standard/full with Docker modules |

  The VM's RAM comes out of WSL's 24 GB, so the **sum of running VMs plus the live
  stack must stay under the cap**; the lab script refuses to start a VM that does not
  fit and prints the arithmetic (the budget gate, used on ourselves).
- **Network:** QEMU user-mode (SLIRP) NAT with explicit host port forwards for SSH
  and the portal. The VM is **not** bridged onto Docker's networks, so it cannot see
  or disturb the live containers. For the Tailscale tests, it joins the tailnet as
  its own node.
- **cloud-init:** a seed ISO per profile creates a user, an SSH key, and runs the
  Bothy installer, exactly as OCI's cloud-init does. Same code path, one fewer thing
  to get wrong later.
- **Control:** `just lab-up <profile>`, `lab-ssh`, `lab-reset`, `lab-snapshot <name>`,
  `lab-down`, `lab-destroy`. All state under `~/lab/` (not in the repo), the scripts
  and cloud-init templates in `lab/` in the repo.
- **Safety rules:** the lab never edits Docker, iptables, `.wslconfig`, DNS or the
  Windows side. Installing the tooling is the only change to this box, listed up
  front and reversible with `apt remove`.
- **Spikes it enables:** S0 (k3s idle cost), S1 (port publishing from a tailnet
  peer), S5 (k3s beside Docker), S6 (core survives a Docker module going over its
  limit), and the full install/upgrade/uninstall tests on a clean OS.

### A.5 Tailnet credentials in the lab

**Caveats (review findings, not yet exercised; S7, S8, S14 and S1 depend on them):** Tailscale behind
SLIRP is double NAT, so S1 throughput and path numbers from the lab are **not representative**; ephemeral
nodes are removed after a delay, a **single-use key breaks `lab-reset`**, and the key sits in the
cloud-init seed, so **delete it after join**. `usermod -aG kvm` needs a new session: use `sg kvm -c`
(`wsl --shutdown` would kill the live containers and is forbidden).

The VM must join the tailnet to test the Tailscale path. Rules:
- Use an **ephemeral, pre-authorized, tagged auth key** with a short expiry, created
  by the owner and placed in `~/lab/secrets/ts-authkey` (mode 0600). Never pasted
  into chat, never committed, never passed on a command line (it shows in `ps`).
- The tag's ACL gives the lab node access **only** to what it needs.
- The ephemeral node disappears from the tailnet when the VM dies.
- A second mode runs the **same flow against a local fake** (no real tailnet) in CI,
  so the logic is tested without credentials.

## B. Install-time connectivity: "how will you reach this?"

### B.1 The question the installer asks first

Before it installs anything else, the installer asks (or takes `--reach`):

| Choice | Meaning |
|---|---|
| **tailscale** | join the tailnet; Bothy and (optionally) SSH reachable over it only |
| **ssh** | ordinary SSH with your key; Bothy on the LAN or localhost |
| **both** | tailnet for Bothy, plus normal SSH as a rescue path |
| **local** | only this machine (or the VM console); nothing exposed |

Default is **the safest that still lets you in**: `tailscale` if a key or login is
provided, else `local`. **Public exposure is never a default** (the OCI repo's
"closed by default" rule applies here too).

### B.2 Tailscale flow

| Step | Detail |
|---|---|
| Install | the vendor's apt repository at a **pinned version**, signing key inline in our repo, as `oci-free/cloud-init.yaml` already does for Tailscale (it does **not** install k3s): **reuse that Tailscale code; extract it to one shared script** instead of two copies |
| Authenticate, one of: | (1) **auth key** from `--ts-authkey-file`/env, for headless VMs and cloud-init; (2) **device login**: `tailscale up` prints a URL (and a QR) and the installer waits until the node appears; (3) an **OAuth client + tag** for fleets (documented, not the default) |
| Flags | `--hostname=<name>`; **`--ssh`** (Tailscale SSH, as this box does) only if chosen; **no exit node, no routes** by default; **pass `--accept-dns=false` explicitly** (the tailscale default is `true`, so "left off" was wrong) and assert `CorpDNS=false` afterwards. Re-running `tailscale up` with different flags errors; change a running node with **`tailscale set`** |
| Bind | **open (see `install-and-bootstrap.md` s7 and `review-findings.md` S8):** binding to the tailnet address is not how hostPort/ServiceLB works; do not claim tailnet-only exposure until the spike passes |
| Verify | `tailscale status` shows the node; **layered ping** to the installing machine (`tailscale ping`, `--tsmp`, `--icmp`, the method from `network/tailnet-troubleshooting.md`); and a **version-skew check** (rule 11: a half-upgraded daemon looks green while dropping packets) |
| ACL honesty | the installer **cannot** change the tailnet's ACLs; it prints a **least-privilege ACL with named users** (the default tailnet ACL is allow-all, so "tailnet only" is not restricted to anyone), and the verify step says "joined but unreachable by ACL" distinctly from "not joined" |

### B.3 SSH flow

- Install and enable `openssh-server` if absent (the VM case; **this box deliberately
  has none**, rule 12, and the installer must not add one to a node that already has
  Tailscale SSH unless asked).
- **Keys only**: `PasswordAuthentication no`, `PermitRootLogin no`. The key comes
  from `--ssh-key <file|string>` or `--ssh-import gh:<user>` (fetched over HTTPS,
  fingerprint **printed and confirmed** before it is trusted).
- Listen address and firewall limited to the chosen CIDR (LAN or tailnet), never
  `0.0.0.0` on a public interface unless explicitly set.
- A sensible brute-force limit (sshd's own `MaxAuthTries`, plus the guard approach
  from `oci-free/node/oci-free-guard.sh` where applicable). No new daemon by default.

### B.4 Never locking yourself out

Changing access on a remote machine is the classic way to lose it. Rules:
- **Apply-with-timer:** any access change from the web (Settings -> Access, the
  `network` module) applies with an **auto-revert in 60 seconds unless confirmed from
  the new path** (the router-style "keep these settings?"). **The revert must be a host unit**
  (not a pod that the change itself may cut off) and confirmation must arrive **over the new
  path**, not the old one.
- The installer **keeps the console path**: for a VM, the serial/console login is the
  last resort and is documented in the output.
- `bothy access reset` (on the host) restores `local`-only plus the original SSH key.
- A **recovery doc** printed at the end, with the exact commands, saved to the
  install receipt.

### B.5 First sign-in on a headless VM

The one-time admin password (#319) has to reach a human who may not be at a
terminal. It is shown **on the installer's own output** and written once to a
root-only file whose path is printed; on a cloud-init install it also goes to the
**serial console log only**, not to a network-reachable place. Rotation is forced at
first sign-in; the file is then wiped.

### B.6 After install, from the web

Settings -> **Access** (the `network` module, k3s runtime): shows how the node is
reachable (tailnet name/IP, SSH state, listening interfaces), lets an operator
change the reach with the apply-with-timer above, rotate the Tailscale key, add or
revoke an SSH key, and see **which ports are open and to whom**. It reads the same
state the installer wrote.

### B.7 What the lab proves for this

| Test | In the lab |
|---|---|
| `--reach local` | nothing listens beyond loopback; portal works via port-forward |
| `--reach ssh` | key login works, password login refused, root refused |
| `--reach tailscale` (real key) | node appears, layered ping from this box passes, portal bytes verified over the tailnet |
| `--reach both` | both work; disabling one does not drop the other |
| lockout drill | apply a bad change; the timer reverts; access returns |
| version-skew drill | simulate the daemon mismatch; verify **fails** instead of reporting green |

### B.8 Decisions needed

| # | Question | Recommendation |
|---|---|---|
| C1 | Default `--reach` when nothing is given | `local` (safe), with a loud prompt to choose |
| C2 | Tailscale SSH vs plain OpenSSH on VMs | offer both; default Tailscale SSH when tailscale is chosen |
| C3 | Does the installer ever install Docker without asking | no: only when a Docker-runtime module is enabled, with the cost shown |
| C4 | Auth key delivery | file or env, never argv; documented for cloud-init |
| C5 | Headscale or other control servers | out of scope; documented as "works if `tailscale up --login-server` is passed through" |

## Changed 2026-11-16

- Status block added: the lab exists, which review items it already implements, the swapless-guest
  gap, and S15. A.5 and B.2 and B.4: review findings (Tailscale flag defaults, ACLs, host-unit revert)
  recorded. **None of the Tailscale items was tested**: S1, S7, S8 and S14 remain open.
- Disagreement resolved: the review asked to refuse the lab above about 50% swap use; `lab/README.md`
  shows swap but does not gate on it, for the reason given above.
