set dotenv-load := true

# Bothy - five containers, ONE compose project on purpose (2026-08-16): the web
# app on :80, bothy-files (editor + config forms), bothy-ops (container + cluster
# actions) and the two socket proxies. Eight containers in four projects until
# 2026-09; see apps/bothy/compose.yml for what merged and what did not.
#
# It used to be three: `portal`, `portal-next` and `portal-files`. Bothy groups
# systems by com.docker.compose.project, so it rendered ITSELF as three separate
# cards in its own Overview - the "why are there 3 portals?" bug. One project,
# one card.
#
# The three files stay separate and are pulled together by `include:` in
# apps/bothy/compose.yml - read that file for why it is `include:` and NOT
# repeated `-f` (the short version: with `-f`, every relative path resolves
# against the FIRST file's directory, which built the editor tier from the web
# tier's Dockerfile and moved its audit log).
#
# apps/bothy-files/compose.yml was in NO lifecycle recipe before this: it ran,
# but `just down` never stopped it and `just up` never started it. It is reached
# through exactly one path now, so it cannot fall out again.
BOTHY := "-f apps/bothy/compose.yml"

# List recipes
default:
    @just --list

# Create the shared docker networks (idempotent)
network:
    -docker network create devnet 2>/dev/null || true
    # opsnet / controlsocknet: the action tier, and the reason it is TWO networks
    # rather than one. opsnet is traefik + bothy-ops and nothing else - bothy-ops
    # can stop containers and scale cluster workloads and authenticates nobody, so
    # the network IS the boundary. controlsocknet is bothy-ops + the two socket
    # proxies: traefik must not be ABLE to reach a proxy that can mutate
    # containers, so the edge meets the service on one network and the service
    # meets its proxies on another. bothy-ops' way out to the cluster is
    # minikube's own network, added by apps/bothy-ops/compose.cluster.yml.
    #
    # controlnet, kubenet and confignet were retired 2026-09 with bothy-control,
    # bothy-kube and bothy-config. They are no longer created; remove the old ones
    # by hand once nothing is attached (`docker network rm ...`).
    -docker network create opsnet 2>/dev/null || true
    -docker network create controlsocknet 2>/dev/null || true
    # socketnet: traefik + bothy-socket-read. docker-socket-proxy has NO auth, so
    # network reachability IS authorisation - on devnet, any of ~20 containers
    # could read the docker socket through it. That proxy is POST=0, so nothing on
    # socketnet can mutate a container through it.
    -docker network create socketnet 2>/dev/null || true
    # filesnet: traefik + bothy-files, and nothing else. bothy-files holds
    # read-write bind mounts on two git repos and has no auth of its own, so the
    # network IS the boundary - authorisation happens at the edge in front of it.
    # Putting it on devnet would hand ~20 containers write access to the docs.
    -docker network create filesnet 2>/dev/null || true

# Bring up EVERYTHING
# `bootstrap` first, and that is not decoration: on a fresh clone Prometheus is
# started with --web.config.file pointing at a gitignored file nothing creates,
# and three directories the services write to do not exist. README.md's own rule
# applies - if a rule can be forgotten, it will be, so put it somewhere it
# cannot be skipped.
#
# Portainer and Dozzle were retired on 2026-08-17 and DELETED on 2026-08-18,
# along with `up-mgmt` and mgmt/. Bothy grew its own answer to both - the Control
# tier manages containers, and Loki plus Grafana hold the logs - so keeping a
# second, unauthenticated copy of each was not a rollback path, it was two more
# things to secure. Dozzle could not even start without a gitignored users file
# that nothing generated, so `just up` used to fail partway through on every
# fresh clone at a service the box does not use.
#
# `git revert` brings them back if that turns out to be wrong; a compose file
# kept on disk "just in case" is how this repo ended up with four of them.
# THE RE-INVOCATION IS THE POINT, and it fixes a bug that made the documented
# one-command install impossible.
#
# `set dotenv-load` reads .env when just PARSES this file - before any recipe
# runs, and therefore before `bootstrap` generates the five credentials a fresh
# clone does not have. So on a first `just up`, compose was handed the values
# that were on disk a moment BEFORE bootstrap wrote the real ones, and died with
#
#     required variable OAUTH2_COOKIE_SECRET is missing a value
#
# on a .env that visibly contained one. Found by `just ci-install`, on its first
# complete run, which is the entire reason that recipe exists.
#
# A nested just is a new process, so it re-reads .env and sees what bootstrap
# wrote. That alone is NOT enough, and the gap is the subtle half: just's
# dotenv-load does not override a variable already in the environment (verified),
# and an EMPTY value in .env is never exported at all.
#
# So the blank OAUTH2_COOKIE_SECRET was simply absent, and the child picked up
# the generated one - which made this look fixed. Every key shipping a non-empty
# PLACEHOLDER was exported by the parent and kept by the child:
#
#   POSTGRES_PASSWORD   Postgres initialises with `changeme-generate-one` while
#                       .env holds a real password, and the next `just up`
#                       cannot connect to the database it just created.
#   BOX_IP              oauth2-proxy dials the placeholder address for OIDC discovery,
#                       times out, crash-loops, and every gated route answers
#                       502 - on a stack whose .env plainly says otherwise.
#
# Hence `env -u` over everything bootstrap may write, not just the secrets. The
# list is scripts/lib/bootstrap-keys.sh, shared with bootstrap so the two cannot
# drift; both failures above were found by `just ci-install`, one after the
# other, because fixing the first revealed the second.
# Bring the whole box up, in dependency order. Runs bootstrap first.
up: bootstrap
    #!/usr/bin/env bash
    set -euo pipefail
    unset_flags=()
    for k in $(bash -c '. scripts/lib/bootstrap-keys.sh && printf "%s " $BOOTSTRAP_KEYS'); do
      unset_flags+=(-u "$k")
    done
    env "${unset_flags[@]}" just _up-all

# Not called directly - `up` runs it in a re-read environment. Split out rather
# than inlined so the dependency ORDER, which is load-bearing, stays declarative.
#
# DATA BEFORE AUTH, and that ordering is a bug fix rather than a preference.
# `keycloak-db-init` creates Keycloak's role and database inside the SHARED
# postgres, which lives in a different compose project - so `depends_on` cannot
# reach it and the script waits on `pg_isready` for sixty seconds instead. A wait
# cannot help when the thing waited for has not been started yet: with auth
# ahead of data, a genuinely fresh box spent a minute failing to resolve the name
# `postgres`, exited 2, and took `just up` down with it.
#
# It never showed up here because postgres was ALREADY RUNNING from the previous
# `just up`, every time. That is the shape of every bug this install job exists
# to find: correct on the machine it was written on, and only there. Found by
# `just ci-install` against an empty daemon.
#
# monitoring moves after data for the same reason, one step milder:
# postgres-exporter dials postgres, and starting it first just means a few
# restarts before it settles.
_up-all: network up-edge up-data up-auth up-monitoring up-apps
    @echo "All stacks up. Run 'just urls' for access."

# Edge: Traefik - the single front door on :80. It no longer routes anything by
# Host header (the name layer was deleted 2026-08-12); what it still owns is the
# portal's host-less /-/api/* data plane and the catch-all that serves the portal
# on the bare IP. Must come up before anything that expects to be routed.
# Edge: Traefik on :80. Must be up before anything that expects routing.
up-edge: network
    docker compose -f edge/compose.yml up -d

# Identity: Keycloak (the IdP) + oauth2-proxy (what Traefik's forwardAuth asks).
#
# One `up -d` brings the whole chain up in order, because the compose file
# expresses the ordering itself: the database bootstrap must EXIT SUCCESSFULLY
# before Keycloak starts, and Keycloak must be HEALTHY before oauth2-proxy and
# the post-import fixes run. So this blocks for as long as that takes - a minute
# or two on first boot, while Keycloak builds and creates its schema.
#
# Nothing here enforces anything yet: it defines the `sso@file` middleware,
# it does not attach it to any router. See edge/dynamic/auth.yml.
# Identity: Keycloak + oauth2-proxy. Blocks until Keycloak is healthy.
up-auth: network
    #!/usr/bin/env bash
    set -euo pipefail
    docker compose -f auth/compose.yml up -d
    # One resolver, not a second copy of the dance - see scripts/lib/box-addr.sh
    # for the order. This one matters more than most: the address printed here
    # has to be the address Keycloak's issuer was built from, or the admin
    # console link works and the login it leads to does not.
    IP=$(bash scripts/lib/box-addr.sh)
    echo ""
    echo "  Keycloak admin   http://$IP:8090/admin  (admin / DEV_LOGIN_PASSWORD in .env - the shared dev login)"
    echo "  OIDC discovery   http://$IP:8090/realms/devbox/.well-known/openid-configuration"
    echo ""
    echo "  The 'issuer' in that document must equal oauth2-proxy's"
    echo "  --oidc-issuer-url exactly. If they ever differ, the symptom is a"
    echo "  redirect loop, not an error. Check it after changing BOX_IP:"
    echo "    curl -s http://$IP:8090/realms/devbox/.well-known/openid-configuration | jq -r .issuer"

# compose.cluster.yml is added ONLY when the docker network `thales-scc` exists
# (the minikube cluster). It joins victoriametrics to that network so it can
# scrape the node; as an `external` network in compose.yml itself it would make
# this recipe fail on every box without the cluster. See that file's header.
# The legacy prometheus/promtail services sit behind compose profiles and are
# NOT started here.
# Observability: grafana, victoriametrics, loki, alloy, cadvisor, node-exporter (+ the cluster, if present)
up-monitoring: network
    #!/usr/bin/env bash
    set -euo pipefail
    files=(-f monitoring/compose.yml)
    if docker network inspect thales-scc >/dev/null 2>&1; then
      files+=(-f monitoring/compose.cluster.yml)
      # The mount source must be a directory before compose creates it as root.
      mkdir -p monitoring/kube-auth
      [ -f monitoring/kube-auth/token ] || echo "note: no monitoring/kube-auth/token - run 'just k8s-monitoring' (kubelet jobs stay DOWN until then)"
    fi
    docker compose "${files[@]}" up -d

# Data services: postgres (+ its exporter).
#
# redis and kafka were RETIRED 2026-08-12 and DELETED on 2026-08-18. Both were
# measured completely idle - redis `DBSIZE` = 0, kafka `--list` = zero topics -
# while together holding ~1,140 MB of the box's 4,678 MB of container memory.
# Their volumes and images went at retirement; the compose files went with the
# rest of the dead weight.
#
# They outlived wiki and mgmt by an afternoon on the argument that they were
# idle rather than REPLACED, so if either were wanted again it would be wanted
# as itself. That argument is what `git revert` is for. A compose file kept on
# disk for a service nobody starts is not a rollback plan, it is a file every
# reader has to ask about - and this repo had four of them.
#
# THEIR DATA IS GONE. An earlier version of this comment said the volumes were
# "PRESERVED, not deleted" - that was true for about twenty minutes. The
# `kafka_data` and `redis_data` volumes were removed afterwards, along with the
# images (apache/kafka, kafbat/kafka-ui, danielqsj/kafka-exporter, redis:8-alpine,
# oliver006/redis_exporter). Verified 2026-08-12: neither name appears in
# `docker volume ls`. So the commands below do NOT restore anything - they pull
# fresh images and start an EMPTY broker / an EMPTY keyspace:
#   docker compose -f data/redis/compose.yml up -d   # new, empty
#   docker compose -f data/kafka/compose.yml up -d   # new, empty
# Nothing that was in them comes back. (Nothing was in them, which is why they
# went; the point is that the instruction must not promise otherwise.)
#
# postgres stays: it is in active use - Keycloak's database lives there.
# Data: Postgres, bound to loopback only.
up-data: network
    docker compose -f data/postgres/compose.yml up -d

# Apps: Bothy - one project, five containers (apps/bothy/compose.yml).
#
# compose.cluster.yml is added ONLY when the docker network `thales-scc` exists
# (the minikube cluster). It joins bothy-ops to that network and mounts its
# token; as an `external` network in compose.yml itself it would fail this
# recipe - and with it the file editor and container actions - on every box
# without the cluster. Without it the kube verbs answer 503 "cluster
# unavailable" and nothing else changes. This replaces `just up-kube` (2026-09).
#
# Both undo nets must exist before bothy-files starts: policy.toml declares them
# and the service refuses to boot without them - a safety net nobody notices is
# missing is worse than none. Docker would create them root-owned otherwise.
#
# Apps: Bothy's five containers, plus the cluster overlay when thales-scc exists.
up-apps: network
    #!/usr/bin/env bash
    set -euo pipefail
    state="${STATE_ROOT:-$HOME/.local/state}"
    mkdir -p "$state/bothy/trash" "$state/bothy/config-trash"
    mkdir -p -m 700 "$state/bothy/inventory"
    # The Settings credentials/backups pages read this; refresh it now so they
    # are not empty until the timer's first run. Metadata only - see its header.
    python3 apps/bothy-ops/inventory.py || echo "note: the admin inventory could not be written - Settings > Credentials will say so"
    files=({{BOTHY}})
    # The Users & roles page: only once `just admin-client` has written a secret.
    if [ -f apps/bothy-ops/secrets/keycloak-admin-client-secret ]; then
      files+=(-f apps/bothy-ops/compose.admin.yml)
    fi
    if docker network inspect thales-scc >/dev/null 2>&1; then
      if [ -d apps/bothy-ops/secrets ]; then
        files+=(-f apps/bothy-ops/compose.cluster.yml)
      else
        echo "note: thales-scc exists but apps/bothy-ops/secrets does not - run 'just kube-token', then 'just up-apps' again (kube verbs answer 503 until then)"
      fi
    fi
    # --remove-orphans: a service dropped from the project (socket-proxy became
    # socket-read in 2026-09) must not keep running under its old definition.
    docker compose "${files[@]}" up -d --remove-orphans

# Stop everything (keeps volumes/data)
down:
    -docker compose -f auth/compose.yml down
    -docker compose -f edge/compose.yml down
    -docker compose {{BOTHY}} down
    # apps/wiki and mgmt/ were DELETED on 2026-08-18, so there is nothing here to
    # bring down any more. The `wiki` database they were kept for went with them:
    # its content was superseded by the Files tier, and it is in the nightly dump
    # if that turns out to be wrong.
    -docker compose -f data/postgres/compose.yml down
    -docker compose -f monitoring/compose.yml down

# Stop everything AND delete all data volumes (DESTRUCTIVE)
# Sits one keystroke from `down` in the recipe list and deletes every data
# volume that still exists: postgres, prometheus, grafana, loki, portainer.
# (redis_data and kafka_data were already deleted on 2026-08-12 - those two
# lines below are now no-ops on this box.)
# DESTRUCTIVE: delete every data volume. Asks for confirmation; irreversible.
nuke:
    @printf "This deletes ALL data volumes. Type yes to continue: " && read ans && [ "$ans" = yes ] || (echo aborted; exit 1)
    -docker compose -f auth/compose.yml down -v
    -docker compose -f edge/compose.yml down -v
    -docker compose {{BOTHY}} down -v
    -docker compose -f data/postgres/compose.yml down -v
    -docker compose -f monitoring/compose.yml down -v

# Show running containers
ps:
    docker ps

# One-glance health check of the whole environment
# Plain `just doctor` never exits non-zero, and should not: the everyday use is a
# human reading the report, and for them an exit code adds nothing while making
# the recipe unusable under `set -e`. The flag is for a caller that wants a
# verdict rather than a report - which until now meant nothing could gate on the
# most complete picture of the stack in this repo.
#
# One-glance health check of the whole environment. `just doctor strict` also exits non-zero on any fault.
doctor mode="":
    @bash scripts/doctor.sh {{ if mode == "strict" { "--strict" } else { "" } }}

# Reproduce the Install CI job on this box, inside docker-in-docker.
#
# NOT a clone in /tmp, which is what everyone reaches for first and which does
# not work: every compose file here pins a top-level `name:`, compose project
# names are GLOBAL to the daemon, and a second `just up` therefore ADOPTS the
# running stack and recreates its containers from the other directory. That has
# already happened here once. A separate daemon is the only real isolation.
#
# Pulls ~6 GB inside the container and takes about as long as the CI job. The
# container is left running afterwards so you can run the suites against it.
#
# Run the whole download-and-run install in an isolated daemon, like CI does.
ci-install:
    @bash scripts/ci-install.sh

# Verify the access model still holds - run after ANY edge/routing change.
# `just verify selftest` additionally proves the template-error probe can fail,
# by voiding a dynamic file on purpose and cleaning it up again.
# Prove the edge actually routes - 23 checks against the running stack.
verify mode="":
    @VERIFY_SELFTEST={{ if mode == "selftest" { "1" } else { "" } }} bash scripts/verify-access.sh

# Could anyone but its author run this? Counts the absolute paths and tailnet
# addresses that are baked in, against a baseline that should only ever shrink.
# Runs against the TREE, so it needs nothing up - which is why it is its own
# recipe rather than a section of `verify`.
# Count the paths and addresses baked in that exist on only one machine.
portability:
    @bash scripts/checks/portability.sh

# Re-render docs/diagrams/*.mmd to docs/assets/diagrams/*.svg. Only the stale
# ones; pass `all` to force every one.
#
# THE SVGs ARE OUTPUT, NEVER SOURCE. apps/bothy-files/policy.toml flags
# `**/*.svg` as `caution` on write, which is right for an SVG a person might edit
# and wrong for these seven - they are machine-generated from the .mmd beside
# them, and scripts/checks/diagrams.sh (CI tier 0) fails the moment the two
# disagree. Edit the .mmd and run this; never touch the .svg.
#
# NOT IN CI, and it cannot be: it drives the headless Chromium under
# ~/.cache/ms-playwright, which a GitHub runner does not have. That is why the
# check hashes rather than re-renders.
# Re-render the architecture diagrams from their mermaid sources.
diagrams *args:
    @python3 scripts/gen-diagrams.py {{ if args == "all" { "--all" } else { args } }}

# Make a fresh clone able to start: check what is missing, create the
# directories the services write to, and generate the gitignored files that
# nothing else creates. Idempotent - a second run says so rather than acting.
# `up` depends on it, because a rule that can be forgotten will be.
# Make a fresh clone runnable: check prerequisites, create dirs, generate secrets.
bootstrap *args:
    @bash scripts/bootstrap.sh {{ args }}

# Checks for the editor tier: path-safety unit tests, per-route role enforcement,
# a full anonymous-refused / login / write round trip, the undo net, and a scan
# of everything the portal SERVES for anything that looks like a credential.
# Checks for the editor tier. `offline` skips what needs the stack up; `ci` skips the box-specific credential survey.
files-check mode="":
    @bash apps/bothy-files/checks/run.sh {{ if mode == "offline" { "--offline" } else { if mode == "ci" { "--skip-survey" } else { "" } } }}

# Checks for bothy-ops: the guard as a pure unit, the socket-proxy grants, both
# HTTP surfaces against stand-ins (a counting fake daemon, a TLS fake apiserver),
# the edge/RBAC/compose wiring, and - unless `offline` - a real container
# transition through real throwaway proxies.
# Checks for bothy-ops (container + cluster actions). `offline` skips the one that needs docker.
ops-check mode="":
    @bash apps/bothy-ops/checks/run.sh {{ if mode == "offline" { "--offline" } else { "" } }}

# apps/bothy-ops/catalog.toml is the only hand-written cluster wiring. This
# regenerates what is derived from it: the edge routers, the RBAC Role, the
# can-i rows of `just kube-token`, and the UI's dev catalog. `check` fails on
# drift instead of writing (CI runs that). Apply RBAC with `just kube-token`.
# Regenerate the kube edge routers, RBAC Role and can-i rows from catalog.toml. `check` only diffs.
ops-wiring mode="":
    @python3 scripts/gen-ops-wiring.py {{ if mode == "check" { "--check" } else { "" } }}
# The Settings area's Keycloak client `bothy-admin` (view-users only), and its
# secret in apps/bothy-ops/secrets. `--rotate` issues a new secret; `--revoke`
# disables the client and deletes the file.
# Create (or rotate/revoke) the read-only Keycloak client behind Settings > Users.
admin-client *args:
    ./scripts/keycloak-admin-client.sh {{args}}

# Settings > Credentials and Backups are served from a metadata-only file written
# on the host - names, modes, ages and sizes, never a value. The timer in
# host/systemd/bothy-inventory.timer runs this every five minutes.
# Rewrite the host-side credential and backup inventory that Settings serves.
admin-inventory:
    python3 apps/bothy-ops/inventory.py

# Back up postgres/redis/grafana/portainer now (nightly timer also runs this)
backup:
    @bash scripts/backup.sh

# Follow a container's logs, e.g. `just logs grafana`
logs service:
    docker logs -f --tail 100 {{service}}

# Open a psql shell on the dev database
psql:
    docker exec -it postgres psql -U ${POSTGRES_USER:-dev} -d ${POSTGRES_DB:-dev}

# `just redis` is GONE (2026-08-12) - redis was retired as idle (0 keys). A
# recipe that always fails is worse than a missing one: it looks like breakage.
# `docker compose -f data/redis/compose.yml up -d` starts a NEW, EMPTY redis:
# the redis_data volume and the images were deleted after the retirement, so
# there is nothing left to restore.

# Regenerate the portal's read-only Prometheus route (edge/dynamic/bothy-prom.yml).
#
# That file carries the basic-auth header the edge injects on the portal's
# behalf, so it is GITIGNORED and generated from .env rather than committed.
# Run this on a fresh clone, and again after changing DEV_LOGIN_*. Traefik
# watches ./dynamic, so no restart is needed.
# Regenerate the portal's Prometheus data-plane route.
bothy-prom-route:
    ./scripts/gen-bothy-prom-route.sh

# (Re)apply the cluster side of monitoring into minikube thales-scc: namespace
# `monitoring`, kube-state-metrics (pinned helm chart, NodePort 30808), the
# kubelet scrape identity, the Alloy DaemonSet shipping pod logs to Loki, and
# the metrics-server addon - then refresh the kubelet token VictoriaMetrics
# scrapes with. Idempotent. See k8s/monitoring/README.md. The compose side is
# `just up-monitoring`.
# Apply cluster monitoring (KSM, alloy, RBAC) into thales-scc and refresh the token.
k8s-monitoring:
    ./scripts/k8s-monitoring.sh

# Rewrite monitoring/kube-auth/token from the cluster's prometheus-scraper-token
# Secret. GITIGNORED (a credential), mode 600 owned by uid 65534 so the
# container's `nobody` can read it (the legacy Prometheus; VictoriaMetrics runs
# as root and reads it either way). No restart needed: the token is re-read on
# every scrape.
# Regenerate the kubelet bearer token VictoriaMetrics scrapes thales-scc with.
kube-prom-token:
    ./scripts/gen-kube-prom-token.sh

# bothy-ops' cluster credential: applies k8s/rbac/bothy-kube.yaml, then writes
# apps/bothy-ops/secrets/{token,ca.crt} (mode 600, gitignored) and prints what
# the account can and cannot do. `--rotate` revokes and reissues; `--revoke` stops.
#
# `just up-kube` is GONE (2026-09): bothy-kube merged into bothy-ops, and
# `just up-apps` adds the cluster overlay by itself when thales-scc exists.
# Issue (or rotate/revoke) bothy-ops' ServiceAccount token for the cluster.
kube-token *args:
    ./scripts/gen-kube-token.sh {{args}}

# Headlamp's cluster credential: applies k8s/rbac/bothy-browse.yaml (the built-in
# `view` ClusterRole - no secrets, exec or port-forward), then writes
# apps/headlamp/secrets/kubeconfig (mode 600, gitignored) and prints the can-i
# table. `--rotate` revokes and reissues; `--revoke` stops.
# Issue (or rotate/revoke) Headlamp's read-only ServiceAccount kubeconfig.
headlamp-token *args:
    ./scripts/gen-headlamp-token.sh {{args}}

# Headlamp, the read-only cluster console, behind its own oauth2-proxy on :8110
# (Keycloak client `headlamp`, role `viewer`). NOT part of `up`, for the same
# reason as up-kube: it joins minikube's `thales-scc` network, which exists only
# while the cluster does. Idempotent: the token is issued only if absent, and
# the Keycloak client (plus its two .env secrets) is re-asserted every run.
# The script writes .env, so compose runs in a nested just that re-reads it.
# Start Headlamp (read-only cluster console, SSO on :8110). Needs the cluster and Keycloak.
up-headlamp:
    #!/usr/bin/env bash
    set -euo pipefail
    docker network inspect thales-scc >/dev/null 2>&1 || {
      echo "no docker network thales-scc - start the cluster first: minikube start -p thales-scc" >&2; exit 1; }
    [ -f apps/headlamp/secrets/kubeconfig ] || ./scripts/gen-headlamp-token.sh
    ./scripts/keycloak-headlamp-client.sh
    env -u HEADLAMP_OAUTH2_CLIENT_SECRET -u HEADLAMP_OAUTH2_COOKIE_SECRET \
      just _up-headlamp
    echo ""
    echo "  Headlamp   http://$(bash scripts/lib/box-addr.sh):8110   (Keycloak login, role viewer)"

_up-headlamp:
    docker compose -f apps/headlamp/compose.yml up -d

# Stop Headlamp and its proxy. Run before `minikube delete`, or the network cannot go.
down-headlamp:
    docker compose -f apps/headlamp/compose.yml down

# Print access URLs. Pure-IP-over-tailscale model: every service has a published
# host port on this node's tailnet IP.
#
# Traefik Host-name routing is DELETED - not
# dormant, not waiting on a DNS layer. Zero Host() rules remain in the router
# table. A new service publishes a port; it does not declare a name.
# The order is the point. VERSION is edited and COMMITTED first, by hand, in its
# own change - then this tags what is already on main. Tagging first and editing
# after leaves a tag pointing at a commit that claims the wrong version, which is
# the exact disagreement scripts/checks/version.sh exists to catch.
#
# Tag the current main as the release named in VERSION. Does not push.
release:
    #!/usr/bin/env bash
    set -euo pipefail
    v=$(tr -d '[:space:]' < VERSION)
    bash scripts/checks/version.sh || {
      echo "Fix VERSION before tagging - see above."; exit 1; }
    git diff --quiet || { echo "working tree is dirty - commit first"; exit 1; }
    [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || {
      echo "releases are cut from main"; exit 1; }
    git tag -a "v$v" -m "Bothy v$v"
    echo "tagged v$v - push it with:  git push origin v$v"

# Print every address on this box, and what is deliberately not running.
urls:
    #!/usr/bin/env bash
    # Identity is read from tailscale at run time and never stored in this repo:
    # the node name/IP identify the owner's tailnet, and this repo is public.
    IP=$(bash scripts/lib/box-addr.sh)
    HOST=$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // ""' | sed 's/\.$//'); HOST=${HOST:-<this-node>}
    echo "This box is a tailnet node: $HOST / $IP - reachable directly."
    echo "Access is by IP:port ($HOST:<port> also works - MagicDNS is free)."
    echo ""
    echo "  ⭐ START HERE   http://$IP/             (the portal - index of everything)"
    echo ""
    echo "  Stack services:"
    echo "    Grafana       http://$IP:3000         (unified dev login)"
    echo "    Metrics (VM)  http://$IP:8428/vmui    (VictoriaMetrics; Prometheus API - unified dev login)"
    echo "    cAdvisor      http://$IP:8082"
    echo "    node-exporter http://$IP:9100"
    echo "    Loki          http://$IP:3100         (API only; 404 at / is normal)"
    echo "    Keycloak      http://$IP:8090/admin   (identity - admin / shared dev login)"
    echo "    Headlamp      http://$IP:8110         (read-only cluster console - Keycloak"
    echo "                                            login, role viewer; only while the"
    echo "                                            thales-scc cluster runs: just up-headlamp)"
    echo ""
    echo "    Files (raw)   http://$IP:8100         (SANDBOX ORIGIN - raw file bytes"
    echo "                                            only. A different port is a"
    echo "                                            different origin, so a hostile"
    echo "                                            SVG/PDF served here cannot touch"
    echo "                                            the portal session. Nothing else"
    echo "                                            may be routed to :8100.)"
    echo ""
    echo "  Deleted 2026-08-18 - Bothy replaced each of them:"
    echo "    Portainer     (was :9000)   start/stop/restart is the Control tier"
    echo "    Dozzle        (was :8080)   logs are on each service page, from Loki,"
    echo "                                which also keeps them after a container is gone"
    echo "    Wiki.js       (was :3001)   docs and notes are the Files tier"
    echo "      WHAT YOU LOSE, said plainly rather than discovered later:"
    echo "        · a shell in the browser. Bothy Control does exec deliberately"
    echo "          NEVER - that is root on this box. Use Tailscale SSH:"
    echo "            ssh devssh@$HOST   then   docker exec -it <name> sh"
    echo "        · image, volume and network management. Those are docker CLI."
    echo "        · a true streaming tail. Bothy polls Loki on a range instead."
    echo "      Retired 2026-08-17, deleted with mgmt/ and apps/wiki/ the next day,"
    echo "      along with the 'wiki' database - superseded, and in the nightly dump."
    echo "      \`git revert\` brings the compose files back if that was wrong."
    echo ""
    echo "  Not running right now - normal, not a fault:"
    echo "    Tilt          http://$IP:10350"
    echo "      NOT a stack service - a per-project dev server under ~/projects"
    echo "      (CVOps, Tals) that you start by hand. Nothing is wrong when this"
    echo "      port is dead; that is its normal state between sessions:"
    echo "        tilt up --host=0.0.0.0"
    echo ""
    echo "  Reserved by projects (listed so the stack never picks them):"
    echo "    CVOps nginx   http://$IP:8086         (project edge, compose mode)"
    echo "    CVOps garage  http://$IP:3900         (S3 blobs - the BROWSER fetches"
    echo "                                           these directly, so it must stay"
    echo "                                           0.0.0.0-bound, not loopback)"
    echo "    Tals frontend http://$IP:5173         (ports in Tals' .ports.lock)"
    echo "    Tals pre-prod  http://$IP:31080        (minikube profile thales-scc, namespace"
    echo "                                           thales-pre-prod; break-glass login)"
    echo "    Tals dev       http://$IP:31081        (namespace thales-dev; seeded, demo logins)"
    echo "                                           Both held open by the user units"
    echo "                                           thales-{preprod,dev}-forward; the"
    echo "                                           cluster starts via minikube.service."
    echo ""
    echo "  Retired 2026-08-12 - measured idle, then DELETED. Data NOT recoverable:"
    echo "    Kafka + Kafka-UI (was :8081)  zero topics      ~1,110 MB"
    echo "    Redis            (was :6379)  zero keys           ~30 MB"
    echo "    minikube         (local k8s)  zero user pods   ~1,046 MB"
    echo "      ^ REBUILT 2026-09-01 as profile \"thales-scc\" - an OpenShift"
    echo "        restricted-v2 SCC emulation (PSA restricted + Kyverno) running the"
    echo "        thales-dev and thales-pre-prod namespaces, started at boot by"
    echo "        minikube.service. The line above records the 2026-08-12 deletion."
    echo "      All three were first stopped and kept, then removed for real:"
    echo "      the kafka_data and redis_data volumes and every image are gone,"
    echo "      and 'minikube delete' ran at 13:56 (no profile remains)."
    echo "      The compose files survive, so these commands still WORK - but"
    echo "      each one builds something BRAND NEW AND EMPTY, it does not"
    echo "      resume anything:"
    echo "        docker compose -f data/kafka/compose.yml up -d   # empty broker"
    echo "        docker compose -f data/redis/compose.yml up -d   # empty keyspace"
    echo "        minikube start                                  # empty cluster"
    echo ""
    echo "  Windows-host mirrors via portproxy: http://100.93.197.10:<port> from the"
    echo "  tailnet, or localhost:<port> on the host. Same ports; LAN is NOT served."
    echo ""
    echo "  Logins: one unified dev login everywhere a login exists - username is"
    echo "  the owner gmail, password = DEV_LOGIN_PASSWORD in the gitignored .env."
    echo ""
    echo "  Name-based routing and the Traefik dashboard were"
    echo "  DELETED on 2026-08-12 - publish a port, never a Host() rule."
    echo "  Route data is still live at http://$IP/-/api/traefik/http/routers"
    echo ""
    echo "Databases stay off the network (loopback-bound). Reach via ssh tunnel:"
    echo "  ssh -L 5432:localhost:5432 $USER@$IP"
    echo "  (6379/redis and 9092/kafka were retired 2026-08-12 - nothing listens"
    echo "   on them now; add those -L flags back if you restart either stack.)"
    echo ""
    echo "If the tailnet IP serves headers but bodies stall, or SSH hangs at KEX:"
    echo "  that is the large-packet blackhole - restart tailscaled ON THIS BOX."
    echo "  See docs/kb/incidents/2026-08-08-wsl-node-large-packet-blackhole.md."
