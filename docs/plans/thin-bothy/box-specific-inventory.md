# Box-specific defaults: inventory for #323

_Read-only audit, 2026-11-16, of code and config (not prose docs). Classes and `file:line` only; no personal values. Classification: a = must become a module setting, b = derive or auto-detect, c = legitimate generic default, d = test fixture. Counts are from a regex sweep plus manual curation; per-row site counts marked ~ are approximate._


Scope: tracked files outside docs/ and ~/claude-notes. Values are named by CLASS; no personal value is repeated. `<ns-dev>`/`<ns-preprod>` stand for the two namespaces named after the owner's work project.

Classes: **a** must become a module setting; **b** should be derived/auto-detected; **c** legitimate generic default; **d** test fixture (lower priority).
Site counts are curated (one actionable site = one count); the raw regex sweep found ~1,350 matching lines (~620 in code/config, ~645 in fixtures, ~80 in prose-in-repo), most of them comments. `~` marks an estimate.

| # | Module | Cls | Value class | Locations (file:line) | Sites | Proposed key | Stranger default |
|---|---|---|---|---|---|---|---|
| 1 | cluster | a | kubectl context / minikube profile default | scripts/k8s-monitoring.sh:33,34; scripts/gen-kube-token.sh:37; scripts/gen-kube-prom-token.sh:30; scripts/gen-collector-token.sh:46; scripts/gen-headlamp-token.sh:35; scripts/doctor.sh:181,184,186; apps/bothy-ops/discover_updates.py:91; apps/bothy-ops/updater/config.py:102; apps/bothy-collector/collect.py:794 | 11 | cluster.context, cluster.profile | none (module off; no kubectl call) |
| 2 | cluster | a | metric/log label value `cluster=` (code and alert rules, must equal the context) | apps/bothy-ops/updater/config.py:105; k8s/monitoring/alloy.yaml:166; monitoring/scrape.d/kubernetes.yml:30,51,76; monitoring/provisioning/alerting/rules.yml:140,147,175,182; apps/bothy-web/web/src/pages/control/ClusterTabs.tsx:880; apps/bothy-web/web/src/pages/control/Cluster.tsx:89 | 11 | cluster.label (default = cluster.context) | none |
| 3 | cluster | b | docker network named after the profile (minikube names it after the profile) | justfile:216,261-ish,304,724,725; apps/headlamp/compose.yml:101,208,209; apps/bothy-ops/compose.cluster.yml:44,47; monitoring/compose.cluster.yml:41,44; scripts/gen-headlamp-token.sh:122-126; scripts/minikube-node-ip.sh:21,22; apps/bothy-web/web/src/pages/settings/Cluster.tsx:130,141 | 15 | derived: cluster.docker_network = cluster.profile | none |
| 4 | cluster | b | apiserver / node address (minikube docker-driver default 192.168.49.2, a LAN-class IP) | apps/bothy-ops/kube.py:70; apps/bothy-ops/compose.yml:77; scripts/gen-collector-token.sh:47; scripts/gen-headlamp-token.sh:36; monitoring/scrape.d/kubernetes.yml:28,49,74 | 7 | derived: cluster.api_address, cluster.node_address (docker inspect / kubectl config view) | none |
| 5 | cluster | a | namespaces the Bothy identity may act in (owner's work-project namespaces) | apps/bothy-ops/guard.py:184; apps/bothy-web/web/src/lib/kube-actions.ts:77; k8s/rbac/bothy-kube.yaml:112,167,183,238; scripts/gen-ops-wiring.py:625-654 (13 rows); scripts/gen-headlamp-token.sh:147-158 (12 probes) | 31 | cluster.namespaces[] | [] |
| 6 | cluster | a | owner's work-app ConfigMap/Secret/Deployment name (resourceNames) | apps/bothy-ops/catalog.toml:61; k8s/rbac/bothy-kube.yaml:118,189; scripts/gen-ops-wiring.py:362,382 | 5 | cluster.managed_configmaps[] | [] |
| 7 | cluster | a | image-registry prefix allowlist (owner's work app image names) | apps/bothy-ops/catalog.toml:68; apps/bothy-web/web/src/components/KubeActions.tsx:256 (placeholder) | 2 | cluster.image_registries[] | [] |
| 8 | cluster | a | owner's work app config schema (25 [configmap_keys.*] tables: solver time limits, SSO, algorithms) in the generic catalog | apps/bothy-ops/catalog.toml:~100-425 | 1 block | cluster.config_schema (file/table per managed app, from module) | empty |
| 9 | cluster | a | job template directories named for namespaces, COPY'd by path | apps/bothy-ops/Dockerfile:30,31; k8s/job-templates/<ns-dev>/*.yaml (3 files); k8s/job-templates/<ns-preprod>/*.yaml (3 files); apps/bothy-ops/catalog.toml job_templates | 8 | cluster.job_templates dir read from module, dirs renamed dev / pre-prod (#323) | none |
| 10 | cluster | a | owner's work-app image name and image tag inside job templates | k8s/job-templates/*/{migrate,seed-identity,seed-reference}.yaml:48-70 (6 files x ~5) | 6 | moves with cluster.job_templates | none |
| 11 | cluster | a | node ports held open for the owner's work-app frontends (31080/31081) and forward unit names | apps/bothy-collector/collect.py:842,843 | 2 | projects.forwards[] {namespace, service, port} | [] |
| 12 | cluster | b | kubectl lookup path under mise (maintainer's tool manager) | apps/bothy-collector/collect.py:863,864 | 2 | derived: PATH lookup, optional cluster.kubectl_path | PATH |
| 13 | cluster | b | chart-apply comment/target in dependabot | .github/dependabot.yml:387 (comment only) | 1 | none (comment) | - |
| 14 | cluster | a | dashboard description names scrape jobs of the box | monitoring/dashboards/box-health.json:61 | 1 | derived/removed text | - |
| 15 | cluster | d | test fixtures naming the context/namespace/ports | apps/bothy-ops/checks/{api_kube,test_guard_kube,wiring,e2e_cluster,...}.py; apps/bothy-web/checks/{cluster,kube-actions,placement,control-home}.mjs; scripts/lib/bothy-kube-probes.sh; scripts/lib/bothy-collector-probes.sh; apps/bothy-web/web/src/lib/*.dev.ts, kube-catalog.dev.json | ~410 | fixtures use neutral names (RFC 6761/example) | - |
| 16 | remote-cluster | a | node address (tailnet) + ssh target default user + `ubuntu` | .env.example:73-77; scripts/gen-oci-grafana-token.sh:31,32,6 | 3 | remote_cluster.node (required_when_enabled), remote_cluster.ssh_target | none, module off |
| 17 | remote-cluster | a | three datasources always provisioned (OCI Prometheus/Loki/Tempo, uids oci-*) plus namespaces/service names of the remote stack | monitoring/provisioning/datasources/datasources.yml:32-96; scripts/normalise-dashboards.py:150 | 4 blocks | remote_cluster.enabled; datasources rendered only when enabled; remote_cluster.{prometheus,loki,tempo}_service | disabled |
| 18 | remote-cluster | a | compose env_file for oci-auth.env and its generator | monitoring/compose.yml:171-176; justfile:674-680; scripts/gen-oci-grafana-token.sh | 3 | moves to store (#324) | - |
| 19 | core | b | tailnet IP of the box in a vite dev proxy | apps/bothy-web/web/vite.config.ts:22 | 1 | derived: core.box_address (VITE_API_PROXY env) | http://localhost |
| 20 | core | a | real tailnet IP as the example value of BOX_IP | .env.example:71 | 1 | core.box_address | auto-detected, else localhost |
| 21 | core | c | BOX_IP required in compose (no fallback, correct) | auth/compose.yml:145,185,190,484,506,521 | 6 | core.box_address (already required) | - |
| 22 | core | c | comment-only tailnet IP / stale doc strings | edge/compose.yml:14; apps/bothy-web/compose.yml:5; auth/compose.yml:236,322 (100.64/10 range, generic) | 4 | none (comment) | - |
| 23 | core | b | home-rooted defaults for state and backups (NOTES/PROJECTS/HOME/STATE/BACKUP_ROOT) | scripts/lib/env.sh:65-69; apps/bothy-files/compose.yml:96,102,115,138,143; monitoring/compose.yml:310,347,451; apps/bothy-ops/compose.yml:111,128,142; justfile:215,285; apps/bothy-ops/updater/config.py:19,23,27; apps/bothy-ops/inventory.py:359,365; apps/bothy-ops/discover_updates.py:985,1054; scripts/bootstrap.sh:413,414 | ~22 | core.state_root (default $XDG_STATE_HOME/bothy or ~/.local/state/bothy), backups.root (default <state_root>/backups) | per-user XDG |
| 24 | core | b | host-log directory name devbox-logs under $HOME | monitoring/compose.yml:310,347; scripts/bootstrap.sh:413 | 3 | core.state_root/logs | derived |
| 25 | core | b | repo location assumed to be ~/stacks (collector output path) and repo name `stacks` | apps/bothy-collector/collect.py:105; host/systemd/* ExecStart; apps/bothy-web/web/src/pages/files/*.ts root id 'stacks' | 3+ | core.install_root derived from repo path; root id kept (c) | derived |
| 26 | core | b | justfile urls recipe: owner login hint, ssh user, owner project ports list, Windows mirror text | justfile:802 (ssh user), :849 (tailnet IP in text), :811-841 (project and port list), :843 (owner email mentioned) | ~6 blocks | urls recipe renders from enabled modules + projects.reserved_ports[]; user = $USER | generic |
| 27 | core | c | DEV_LOGIN_USER placeholder uses example.com (RFC 2606) | .env.example:35; apps/bothy-web/web/src/lib/me.ts:61; apps/bothy-web/web/src/pages/settings/Audit.tsx:68 | 3 | login.admin_user (default `admin`) | admin |
| 28 | core | c | realm name devbox and compose project names | auth/realm-devbox.json; many | - | none (neutral) | - |
| 29 | files | a | notes root defaulting to ~/claude-notes, rw | apps/bothy-files/compose.yml:96; scripts/lib/env.sh:65; apps/bothy-files/policy.toml:39-41 | 3 | files.roots[] {id,path,writable} | [] (only Bothy docs) |
| 30 | files | a | projects root ~/projects (ro) and the whole $HOME exposed as root `home` (ro, aliases) | apps/bothy-files/compose.yml:102,115; scripts/lib/env.sh:66,67; apps/bothy-files/policy.toml:43-84 | 5 | files.roots[]; home root removed unless added | [] |
| 31 | files | a | deny_toplevel = ["backups"] assumes ~/backups under the home root | apps/bothy-files/policy.toml:84 | 1 | derived from backups.root | - |
| 32 | files | b | root ids notes/projects/home baked into policy and docs links in web | apps/bothy-files/policy.toml:35-55; apps/bothy-web/web/src/pages/settings/About.tsx:123-128 (links into the stacks root) | ~8 | files.roots[] ids; About links keyed to bundled docs root | stacks (bundled docs) |
| 33 | files | c | dotenv example filenames (.env.example etc.) in deny/allow lists | apps/bothy-files/policy.toml:175 | 1 | - | - |
| 34 | core | b | Windows/WSL assumption in user-facing strings: tailscale SSH, `ssh <user>@`, linger | justfile:802; apps/bothy-ops/updater/owncode.py:581; apps/bothy-ops/control.py:28-30 | 3 | derived $USER; host-timers.linger text conditional | - |
| 35 | host-timers | a | user name, home path, ExecStart paths, PATH with mise shims in every unit | host/systemd/{bothy-updater.service,bothy-updater.path,bothy-updater-auto.service,bothy-updater-auto.timer,bothy-updates-discover.service,bothy-inventory.service,stacks-backup.service}: User=, Group=, HOME=, PATH=, WorkingDirectory=, ExecStart=, Documentation=, PathExistsGlob= | ~45 | core.install_user (derived id -un), core.install_root, core.state_root; templates rendered by `just install-updater` | derived |
| 36 | host-timers | a | minikube unit: user, home, mise shim path, profile name, owner-project description text | host/systemd/minikube.service:1-41 | ~14 | cluster.profile + install_user; unit only rendered when cluster module enabled and manage_minikube=true | off |
| 37 | host-timers | c | GitHub repo URL in Documentation= of wsl-fix-mtu | host/systemd/wsl-fix-mtu.service:3 | 1 | none | - |
| 38 | windows-host | a | default WSL user, 24GB/10-processor wslconfig sized for this machine | host/wsl/wsl.conf:5; host/wsl/wslconfig:2,3 | 3 | windows_host.wsl_user, memory, processors | WSL defaults / unset |
| 39 | windows-host | a | tailnet IP listeners and Windows path and task principal SID baked into scheduled task XML + portproxy script | host/windows/refresh-portproxy.ps1:24,77; host/windows/install-portproxy-refresh.cmd:4; host/windows/DevBox-Portproxy-Refresh.xml:26,46; host/windows/DevBox-WSL-Keepalive.xml | ~8 | windows_host.listen_addresses (derived), windows_host.task_user; XML templated | module off |
| 40 | windows-host | a | dnsmasq config bound to tailnet IP, `.test` zone, retired | host/dnsmasq/dev.conf:18,48; host/wsl/resolv.conf:7-9,14 (Windows NAT resolver 10.255.255.254) | 4 | delete (retired, #325) | - |
| 41 | windows-host | c | MTU fix generic WSL+Tailscale logic | host/wsl/sbin/wsl-fix-mtu; host/systemd/wsl-fix-mtu.service | 2 | windows_host.enabled | opt-in |
| 42 | projects | a | collector scans ~/projects 3 levels deep (PROJECT_ROOTS) | apps/bothy-collector/collect.py:96 | 1 | projects.roots[] | [] |
| 43 | projects | a | placement rule for owner work-project SonarQube containers (named after the work project) | apps/bothy-collector/placement.yml:39,42 | 2 | projects.placement[] | [] (file ships empty or generic) |
| 44 | projects | a | HOST_OVERRIDES entry for a tilt dev server of the owner's work project | apps/bothy-web/web/src/lib/discover.ts:1872-1876 | 1 | projects.host_overrides[] | [] |
| 45 | projects | b | known project names in display code (sonarqube label, tilt runtime classification) | apps/bothy-web/web/src/lib/ui-names.ts:30; discover.ts:189 | 2 | c-ish (generic tool names), review | - |
| 46 | projects | a | just urls reserved-ports table naming owner projects and ports (8086,3900,5173,3020,5433,31080,31081,10350) | justfile:809-841 | 8 ports | projects.reserved_ports[] | [] |
| 47 | projects | d | dev fixtures naming the owner projects | apps/bothy-web/web/src/lib/{discover,systems,projects}.ts comments; apps/bothy-web/checks/*.mjs | ~190 | neutral names | - |
| 48 | updates | c | upstream repo owner/name for update checks and User-Agent | apps/bothy-ops/updates.toml:216,220; discover_updates.py:86; updater/owncode.py:283; scripts/bothy:45; scripts/bothy.sh:4,83 | 7 | core.upstream_repo (public, correct; deliberately generic per #323) | the public upstream repo |
| 49 | updates | a | update window 03:30-05:00 tied to the 03:00 backup timer | apps/bothy-ops/updates.toml:79-81 | 3 | updates.window_start/end (generic default exists) | 03:30-05:00 (c if keep) |
| 50 | updates | a | updates.toml component text naming the owner cluster label in verify steps | apps/bothy-ops/updates.toml:251 | 1 | derived from cluster.label | - |
| 51 | updates | b | backup freshness checks assume ~/backups/<kind> | apps/bothy-ops/updater/{auto,classes,groups,plans,pgmajor,configvalue}.py (messages) | ~7 | derived backups.root | - |
| 52 | ops | a | kube cluster guard docs strings naming owner context (module docstrings) | apps/bothy-ops/{kube,guard,app}.py, updater/{cluster,k8s}.py (comments) | ~12 | comments only | - |
| 53 | metrics | b | alert rules with `cluster="..."` selectors and Kubernetes scrape job file mounted for one cluster | monitoring/provisioning/alerting/rules.yml:115-182; monitoring/scrape.d/kubernetes.yml (whole file, mounted by compose.cluster.yml) | 2 files | rendered from cluster.* ; rules dropped when cluster off | none |
| 54 | metrics | c | loopback ports of own stack services (8428, 3100, 9090) generic Bothy defaults | scripts/lib/backup-lib.sh; scripts/restore.sh; scripts/doctor.sh:118 | ~10 | - | - |
| 55 | sso | b | trusted proxy CIDR = docker default bridge | auth/compose.yml:538 | 1 | derived from docker network | 172.18/16 fallback |
| 56 | github | a | CODEOWNERS owner and issue-template/ SECURITY links to the owner's GitHub; LICENSE copyright; CoC contact | .github/CODEOWNERS:16; .github/ISSUE_TEMPLATE/{config.yml:4,9,12,15,bug_report.yml:14,121}; LICENSE:3; CODE_OF_CONDUCT.md:62 | 9 | repo identity (c for a public project; forks must rewrite) | keep |
| 57 | github | c | runners ubuntu-latest; bot email noreply | .github/workflows/*.yml | - | - | - |

## Totals (curated sites)

By class: a=209, b=83, c=36, d=600

| Module | a | b | c | d | total |
|---|---|---|---|---|---|
| cluster | 78 | 25 | 0 | 410 | 513 |
| projects | 12 | 2 | 0 | 190 | 204 |
| host-timers | 59 | 0 | 1 | 0 | 60 |
| core | 1 | 38 | 14 | 0 | 53 |
| files | 9 | 8 | 1 | 0 | 18 |
| updates | 4 | 7 | 7 | 0 | 18 |
| windows-host | 15 | 0 | 2 | 0 | 17 |
| ops | 12 | 0 | 0 | 0 | 12 |
| metrics | 0 | 2 | 10 | 0 | 12 |
| remote-cluster | 10 | 0 | 0 | 0 | 10 |
| github | 9 | 0 | 1 | 0 | 10 |
| sso | 0 | 1 | 0 | 0 | 1 |

Non-fixture total: 328 sites; fixtures ~600.
