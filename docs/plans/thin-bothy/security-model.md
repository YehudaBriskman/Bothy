# Security model

_Revised 2026-11-16 for the hybrid decision (`hybrid-runtime.md`): the first draft
said "no Docker socket, deleted". That was the all-in-k3s world. Docker-runtime
modules (Keycloak, Grafana, Loki, Postgres) stay, so **two privileged paths exist**
and both need a boundary: a Kubernetes one (RBAC, section 2) and a host one
(`bothy-hostd`, section 6.1). Today's socket proxies are not deleted; the k3s core
simply stops needing them._

Moving k3s-runtime work into the cluster **adds** a boundary (Kubernetes RBAC). The
Docker-runtime half keeps today's. The goal is that every boundary is at least as
constrained as `grants.py` and `router-gates.sh` make today's, and checked by CI.

## 1. What disappears, and what stays

| Today | Fate | Why |
|---|---|---|
| `bothy-socket-read` / `-write` | **stay**, for Docker-runtime modules only (read proxy for discovery; writes go through `bothy-hostd`, section 6.1) | Docker modules still exist; the "no `POST=1` with `CONTAINERS=1` behind a browser-reachable path" rule is unchanged |
| `bothy-collector` host process + `kube-auth/` token files | goes **only for the k3s core** (in-cluster tokens); stays while any remote-cluster or Docker-side collection needs it | a long-lived token on disk is still a token on disk |
| The host updater as the privileged actor | **split**: k3s modules by a namespaced Job, Docker modules by `bothy-hostd` | `updates-and-rollback.md` |
| `compose.admin.yml` / the admin tier | stays for Docker modules; k3s uses RBAC verbs per ServiceAccount | |

## 2. What is new

### 2.1 Identities in the cluster

| ServiceAccount | Can | Cannot |
|---|---|---|
| `bothy-web` | nothing (serves static files) | everything |
| `bothy-api` | **read** pods, deployments, events, metrics in module namespaces; **create** `Job` from the one update template **(only with the admission policy of 6.2 in force; RBAC alone cannot constrain what a created Job contains)** | patch workloads, read Secrets |
| `bothy-settings` | read/write its own PVC; create module Secrets in module namespaces | list other namespaces' Secrets |
| `bothy-update-<module>` | `helm`-equivalent verbs **only in `bothy-<module>`**; Helm stores release state as Secrets, so it needs Secret access **in that namespace** | other namespaces, cluster-scoped objects, `impersonate`, `escalate`, `bind` |
| `bothy-backup-<module>` | read that module's PVC, write the backup target | anything else |

Cluster-scoped rights are deliberately rare and enumerated: `PriorityClass` and
CRD installs happen at **install time** by the installer, not by any runtime SA.
**The update Job runs as its bound ServiceAccount; it does not "impersonate a Role".**
Roles come from the platform allow-list keyed by component id, never from the
module's own files. **The core operator owns `Namespace`, `ResourceQuota`,
`LimitRange` and `NetworkPolicy`; a module chart may not create or modify them**
(otherwise a module could delete its own sandbox).

### 2.2 Roles (people) vs identities (pods)

The three user roles (viewer, editor, operator; the repo also defines a `shell` role that no route uses yet. There is **no `admin` role**) and **exact-`Path()` routers with
role middlewares** survive unchanged. The identity provider underneath changes with
the module (`login` or `sso`), so the role layer must sit **above** both: the API
asks "is this request operator?" of an auth adapter, never of Keycloak directly.
This is the one new abstraction the plan adds to security, and it gets its own test
matrix: every route x every role x both providers.

### 2.3 Network

- **Default-deny NetworkPolicy** per namespace; each module declares the flows it
  needs (to traefik, to metrics, to Postgres) in its module file, and the policy is
  generated from that. (k3s ships a NetworkPolicy controller; verify it is enabled in
  the S0 spike, as it adds memory.)
- Only Traefik is reachable from outside the node. No NodePort except where a
  decision (S1) chooses it, and then through a policy.
- The Kubernetes API is **not** exposed beyond the node (as oci-free: administration
  over the private network only).

### 2.4 Secrets

- The settings store owns them (#316/#317); the cluster holds the **projection** as
  Kubernetes Secrets, mounted as files.
- Enable **k3s secrets encryption** (`--secrets-encryption`) so Secrets in the
  datastore are not plaintext at rest. Be honest: the key is on the same node, so it
  protects copies of the datastore, not root on the host (the same threat model
  statement as #316).
- **The master key (KEK) lives in a host file outside the datastore** and is the
  canonical copy (`settings-store.md` s9.2, Q4). A cluster Secret copy for the
  settings pod exists only in its own namespace and **only once the admission policy
  of 6.2 is enforced**; a datastore copy or k3s-state backup is therefore key-bearing.
  A cluster Secret cannot be "excluded from backups"; only a host file can.
- **k3s listeners:** the apiserver (6443) and kubelet (10250) bind all interfaces by
  default. Install with `--bind-address`/`--advertise-address` and a host firewall rule,
  kubeconfig `0600` root-only (the k3s default, measured in S5c; the earlier install
  draft's `0640` is withdrawn), and a listener check in the install verify.
- No secret in Helm values, ConfigMaps, Job args, pod env (use files) or logs.
  `helm get values` on every release is a CI fixture that must contain none.

### 2.5 Pods

A **restricted** baseline on every module namespace (Pod Security Admission
`restricted`): non-root, read-only root FS where possible, no privilege escalation,
dropped capabilities, `seccompProfile: RuntimeDefault`. Exceptions need a reason in
the module declaration. **Core pods are Guaranteed QoS and never use `hostPort`**
(S5b: a hostPort shadows a host listener or a Docker port with no error; S6: stock
BestEffort pods carry `oom_score_adj` 1000). The one `hostPath` exemption is named in
6.1 (the spool), not left open. This subsumes #336 (run the web image's nginx as non-root).

## 3. CI-checked assertions (replacing `grants.py` / `router-gates.sh`)

1. No ServiceAccount except the listed ones exists; the update SAs are namespaced.
2. `bothy-api` has no `patch`/`update`/`delete` on workloads and no `get` on Secrets;
   `kubectl auth can-i --list` for **every** ServiceAccount equals a committed snapshot
   with no `impersonate`, `escalate` or `bind`.
3. Every module's pods have requests and limits, non-root, no `hostPath`,
   no `privileged`, no `hostPort`, no `hostNetwork` (unless declared with a reason).
   Core pods are Guaranteed (request = limit, CPU included).
4. Every exposed route is an exact `Path()` IngressRoute, carries the role
   middleware of its tier, and a **GET returns no secret value** (the #317 fixture).
5. NetworkPolicy exists in every namespace and is default-deny.
6. Images are pinned by digest and not `latest`.
7. A rendered chart for every mode passes `kubeconform` and the above (static),
   plus a **live** check on a throwaway k3s that these hold in the running cluster.
8. **Live admission test:** a privileged pod, a hostPath pod, and a Job created as the
   api ServiceAccount with a foreign image, SA or Secret mount are all **rejected**.
9. **Fresh-install scan:** 6443 and 10250 unreachable from the LAN; no secret in any
   GET, `helm get values`, Job spec, log or cloud-init output; no first-run credential
   in a world-readable file.
10. **Docker-side (hostd) assertions:** the executor accepts only the closed request
   schema of 6.1; a request with a symlink, a non-regular file, `nlink > 1`, a foreign
   UID or an unknown component id is refused; no argv is ever built from request text.

## 4. New risks this introduces

| Risk | Mitigation |
|---|---|
| A bug in `bothy-api` creating Jobs with attacker-chosen args | the Job template is fixed; api fills only allow-listed ids; tested with hostile input |
| Over-broad update Roles | generated from declarations, asserted by CI (rule 1 above) |
| Admission/PSA misconfigured and silently permissive | a live test that a deliberately privileged pod is **rejected** |
| Auth adapter drift between `login` and `sso` | one test matrix, both providers |
| k3s apiserver exposure | not bound beyond the node; listener check in install verify |
| The Traefik API (rule 2): the dashboard stays off; `/api/rawdata` leaked a Basic header once | keep `--api=true` only, never `--api.dashboard`; no auth headers in middlewares |

## 5. The doc that must exist before code

`SECURITY.md` gets a section "In-cluster boundary" with the table in 2.1 and the
assertions in 3. The plan is not merged-to-build until that text is reviewed, since
that file is what later changes are held to.

## 6. The host executor, the admission policy and supply chain (added 2026-11-16)

### 6.1 `bothy-hostd`: the second executor

Decision: `hybrid-runtime.md` s4 option A. The design reuses today's spool pattern and
hardens it; the first draft only named it.

- **Request schema (closed):** `{id, component, action, plan_id}` where `action` is
  one of a fixed enum (`up`, `down`, `restart`, `update`, `rollback`) and `component`
  must be an id in the **module catalog**. No free-text field exists. The executor
  maps (`component`, `action`) to **fixed argv** (`docker compose -f <catalog path> ...`)
  and never builds argv from request text.
- **Spool hardening:** the spool directory is owned by a **distinct UID** (not the
  install user, not `bothy-api`'s); the API may only create files. The executor opens
  with `O_NOFOLLOW`, requires a regular file with `nlink == 1`, **claims by rename**
  into a private directory, parses **once**, re-validates `plan_id` against a freshly
  computed plan, and refuses a stale one.
- **The single `hostPath` exemption:** the spool directory mounted into `bothy-api`,
  write-only, one named path. It is listed in the module declaration and in the CI
  allow-list; every other `hostPath` is a CI failure.
- **Discovery** (Docker side) goes through the read proxy only; a pod never gets a
  hostNetwork or hostPath view that leaks `docker inspect` environment values.
- **Failure isolation:** if `bothy-hostd` is down, k3s modules and the portal keep
  working and the UI reports "Docker modules: executor not running". It is a host
  unit, so it is covered by the host watchdog (`modes-and-modules.md`, alerts).

### 6.2 Admission policy (a hard prerequisite for the k3s install)

RBAC cannot constrain what a `create` contains: `bothy-api` creating Jobs can mount any
Secret in its namespace, including the master key. Therefore a
**ValidatingAdmissionPolicy** (built into current Kubernetes; no extra pod) is required
before the k3s path ships (`settings-store.md` Q4, owner decision):

- Jobs created by the api ServiceAccount: image pinned by digest from the allow-list,
  fixed command, allow-listed ServiceAccount, **no Secret volumes or `envFrom`**.
- Nothing but the core operator may create or change `Namespace`, `ResourceQuota`,
  `LimitRange`, `NetworkPolicy` or namespace labels.
- Plus the Pod Security `restricted` baseline of 2.5. The master key sits in its own
  namespace so a policy mistake in a module namespace cannot reach it.

**ASSUMPTION:** k3s's bundled apiserver version serves `ValidatingAdmissionPolicy`
without extra flags. Settle in the lab with the live admission test (assertion 8);
the lab has run stock k3s v1.37.2 (S0) but never this policy.

### 6.3 Supply chain and a sharper threat statement

- Signed tags or commits for what `main` pins; a **72 h cooldown** before `auto`
  applies a new pin; image signature verification where the registry supports it;
  the installer's own hash published **out of band** (not only in the repo that
  carries the installer).
- **The lab is not a sandbox (S15):** a guest root can remove cloud-init's rule and
  reach the host's loopback. The lab is for our own installer and k3s tests, never
  for untrusted code. This bounds what "tested in the VM" can claim.
- **Coexistence is a security surface, not only an ops one:** a hostPort can shadow a
  host or Docker listener silently (S5b), which is a traffic-interception primitive
  for anyone who can create a pod. The restricted baseline forbids `hostPort`; the
  admission policy must too.

## Changed 2026-11-16

- **Section 1** no longer says the socket proxies and the host updater are deleted.
  Contradicted by the decision that Docker modules stay (hybrid runtime, `hybrid-runtime.md`).
- **2.1** the "impersonates the Role" model is withdrawn; RBAC alone cannot constrain
  Job contents (review finding, an inference: the live admission test is the proof).
- **2.4** kubeconfig mode `0640` withdrawn: k3s writes `0600` (S5c).
- **2.5, section 3** `hostPort` is forbidden and core is Guaranteed (S5b, S6).
- Sections 6.1 to 6.3 are new; assertions 8 to 10 are new CI invariants.
- Not measured: the admission policy, `bothy-hostd` and the SA snapshot have never run.
