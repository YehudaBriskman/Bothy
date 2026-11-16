# Install and bootstrap

The install must be **short, idempotent, honest about what it touches, and produce
mini** without questions. Everything after that is the web.

## 1. The three targets

| Target | How k3s gets there | Notes |
|---|---|---|
| **Linux box / VM** | the installer script | the reference path |
| **WSL2** (this box) | same script, plus WSL-specific checks | systemd must be on (it is, here); Windows keepalive is a separate opt-in module |
| **OCI Always Free A1** | `cloud-init` from `oci-free` runs the same installer | the repo `oci-free` already does k3s bootstrap; Bothy's installer becomes the thing its cloud-init calls, instead of a parallel recipe |

Dev (Compose) stays `just up`, untouched by this document.

## 2. What the installer does, in order

1. **Preflight** (read-only, prints and stops on failure): OS and arch, systemd,
   RAM and disk against the mini budget, free ports, an existing k3s or Docker,
   whether `$HOME` is writable. A WSL2 check reads the memory cap and warns when it
   is below the budget.
2. **Install k3s** at a **pinned version**, with flags chosen by the profile:
   `--disable metrics-server`, `--write-kubeconfig-mode 0640`, a widened or default
   NodePort range per the S1 spike, `--secrets-encryption`, kubelet image-GC
   thresholds, and `--kube-apiserver-arg` audit settings (small, log to a file).
3. **Create `bothy-system`**, the PriorityClasses, the default LimitRange, and
   NetworkPolicy defaults.
4. **Generate secrets**: the settings master key (a Secret, never printed), the
   **one-time admin password** (printed once, to the terminal only), cookie secrets.
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
- The admin password is generated, shown once, and stored **only as a hash**. A lost
  password is recovered by a **host-only reset** (`bothy admin reset`, run on the
  node, which writes a fresh one-time password through the cluster API with a
  node-local credential), not by an email flow.
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
| `bothy uninstall --purge` | typed confirmation; also deletes PVCs and uninstalls k3s via its own uninstall script; leaves only the receipt and backups |
| `bothy reset-first-run` | back to the first-run wizard without touching data |

Uninstall must leave nothing the receipt did not create (the existing CI rule: "`down`
leaves nothing", extended).

## 7. WSL2-specific checks (from the notes' hard-won rules)

- **Tailnet IP binding**: k3s's `--node-ip` and the Traefik listeners bind to the
  node's tailnet address, so a Windows-side NAT address change does not break
  access (the 2026-08 incidents were all client-side; the design must not add a
  server-side cause).
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
