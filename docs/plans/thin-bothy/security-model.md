# Security model

Moving into the cluster **deletes** the most security-critical piece of the current
design (the Docker socket proxies and their `POST=1`/`CONTAINERS=1` rule) and
**creates** a new one (Kubernetes RBAC). The goal is that the replacement is at
least as constrained and is checked by CI the way `grants.py` and `router-gates.sh`
check today's.

## 1. What disappears

| Today | Risk it managed | Why it goes |
|---|---|---|
| `bothy-socket-read` / `-write` | the Docker API is root on the host | Bothy no longer needs Docker access: there is no Docker socket to proxy |
| `bothy-collector` host process + `kube-auth/` token files | a long-lived token on disk | in-cluster ServiceAccount tokens are short-lived and mounted by the kubelet |
| The host updater as the privileged actor | a host root path | replaced by a namespaced Job (`updates-and-rollback.md`) |
| `compose.admin.yml` / the admin tier | splitting write ability | becomes RBAC verbs per ServiceAccount |

## 2. What is new

### 2.1 Identities in the cluster

| ServiceAccount | Can | Cannot |
|---|---|---|
| `bothy-web` | nothing (serves static files) | everything |
| `bothy-api` | **read** pods, deployments, events, metrics in module namespaces; **create** `Job` from the one update template | patch workloads, read Secrets |
| `bothy-settings` | read/write its own PVC; create module Secrets in module namespaces | list other namespaces' Secrets |
| `bothy-update-<module>` | `helm`-equivalent verbs **only in `bothy-<module>`** | other namespaces, cluster-scoped objects |
| `bothy-backup-<module>` | read that module's PVC, write the backup target | anything else |

Cluster-scoped rights are deliberately rare and enumerated: `PriorityClass` and
CRD installs happen at **install time** by the installer, not by any runtime SA.

### 2.2 Roles (people) vs identities (pods)

The three user roles (viewer, operator, admin) and **exact-`Path()` routers with
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
- No secret in Helm values, ConfigMaps, Job args, pod env (use files) or logs.
  `helm get values` on every release is a CI fixture that must contain none.

### 2.5 Pods

A **restricted** baseline on every module namespace (Pod Security Admission
`restricted`): non-root, read-only root FS where possible, no privilege escalation,
dropped capabilities, `seccompProfile: RuntimeDefault`. Exceptions need a reason in
the module declaration. This subsumes #336 (run the web image's nginx as non-root).

## 3. CI-checked assertions (replacing `grants.py` / `router-gates.sh`)

1. No ServiceAccount except the listed ones exists; the update SAs are namespaced.
2. `bothy-api` has no `patch`/`update`/`delete` on workloads and no `get` on Secrets.
3. Every module's pods have requests and limits, non-root, no `hostPath`,
   no `privileged`, no `hostNetwork` (unless declared with a reason).
4. Every exposed route is an exact `Path()` IngressRoute, carries the role
   middleware of its tier, and a **GET returns no secret value** (the #317 fixture).
5. NetworkPolicy exists in every namespace and is default-deny.
6. Images are pinned by digest and not `latest`.
7. A rendered chart for every mode passes `kubeconform` and the above (static),
   plus a **live** check on a throwaway k3s that these hold in the running cluster.

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
