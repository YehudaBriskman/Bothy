# shellcheck shell=bash
# Shared by scripts/backup.sh and scripts/restore.sh. Sourced, never executed.
#
# WHAT LIVES HERE: the names of the containers that hold state, the one helper
# image both scripts borrow, and a tiny HTTP client that runs INSIDE a
# container's network namespace. Everything is overridable from the
# environment, and that is not generality for its own sake: it is how the
# restore recipes are tested against THROWAWAY containers (BK_PG=bk-test-pg ...)
# without ever pointing them at the live services.

# The containers. Defaults are the container_name: values in the compose files.
: "${BK_PG:=postgres}"
: "${BK_GRAFANA:=grafana}"
: "${BK_VM:=victoriametrics}"
: "${BK_LOKI:=loki}"
: "${BK_ALLOY:=alloy}"
# What a postgres restore stops while it drops and recreates databases, and
# starts again afterwards. keycloak is the tenant of the `keycloak` database and
# caches realm data in memory, so it must not keep running across a restore.
#
# `-`, NOT `:=`, and this one matters: `:=` also replaces an EMPTY value, so
# `BK_PG_DEPENDENTS=""` - "stop nothing", what a test against a throwaway
# postgres says - silently became "stop keycloak". The first test run of
# restore.sh restarted the LIVE keycloak that way, while restoring into a
# throwaway container. Empty has to mean empty.
BK_PG_DEPENDENTS=${BK_PG_DEPENDENTS-keycloak}

# One small image for everything the stateful containers cannot do themselves:
# grafana/grafana ships no sqlite3, grafana/loki is distroless (no shell, no
# tar), and none of them should be handed a curl. python:alpine has sqlite3 (the
# module, which is SQLite's online-backup API), busybox tar and python's urllib.
# It is borrowed with `docker run --rm`, never left running.
: "${BK_HELPER_IMAGE:=python:3.13-alpine}"

# How many to keep. The small things are cheap, so two weeks; the time-series
# stores are hundreds of MB each and are history rather than configuration, so
# three nights is enough to get back past one bad day.
: "${BK_KEEP:=14}"
: "${BK_KEEP_BIG:=3}"

bk_running() { docker ps --format '{{.Names}}' | grep -qx -- "$1"; }
bk_exists()  { docker ps -a --format '{{.Names}}' | grep -qx -- "$1"; }

# bk_http <container> <METHOD> <url> - an HTTP request made from INSIDE
# <container>'s network namespace, so it needs no published port (a throwaway
# test container has none) and no curl in the target image.
#
# Basic-auth credentials, if any, are read from STDIN as `user:password` and
# never appear in any argv - the same rule doctor.sh follows with curl's
# `--config -`. Prints the body; exits non-zero on a non-2xx status.
bk_http() {  # <container> <METHOD> <url>   (stdin: optional user:password)
  docker run --rm -i --network "container:$1" "$BK_HELPER_IMAGE" python3 -c '
import base64, sys, urllib.error, urllib.request
method, url = sys.argv[1], sys.argv[2]
cred = sys.stdin.read().strip()
req = urllib.request.Request(url, method=method, data=b"" if method == "POST" else None)
if cred:
    req.add_header("Authorization", "Basic " + base64.b64encode(cred.encode()).decode())
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        sys.stdout.write(r.read().decode(errors="replace"))
except urllib.error.HTTPError as e:
    sys.stdout.write(e.read().decode(errors="replace")); sys.exit(1)
except Exception as e:
    print(e, file=sys.stderr); sys.exit(2)
' "$2" "$3"
}

# VictoriaMetrics' basic-auth pair, read from the SAME files the running
# container enforces (its entrypoint reads them at start). Reading them out of
# the container rather than from monitoring/ on the host means this can never
# disagree with what VM actually checks, and a throwaway VM with no auth files
# yields an empty string, which bk_http treats as "no auth".
bk_vm_cred() {  # <container>
  local u p
  u=$(docker exec "$1" cat /etc/prometheus/prom-username.txt 2>/dev/null) || return 0
  p=$(docker exec "$1" cat /etc/prometheus/prom-password.txt 2>/dev/null) || return 0
  printf '%s:%s' "$u" "$p"
}

bk_vm_api() {  # <container> <METHOD> <path>
  bk_vm_cred "$1" | bk_http "$1" "$2" "http://127.0.0.1:8428$3"
}

# Poll until <cmd...> succeeds or <seconds> pass. Loki in particular answers
# /ready with 503 for ~15s after it starts, by design.
bk_wait() {  # <seconds> <cmd...>
  local n=$1; shift
  for _ in $(seq 1 "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

bk_human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "${1}B"; }

# ── the two time-series snapshots ───────────────────────────────────────────
#
# Functions rather than inline steps since 2026-09-19, because two callers take
# them: scripts/backup.sh (nightly) and the host updater's pre-update snapshot
# (apps/bothy-ops/updater, through scripts/snapshot.sh). One way to take each,
# so a pre-update copy is exactly what `just restore-victoriametrics` and
# `just restore-loki` already know how to put back. The WHY of each shape is
# written at the call sites in backup.sh; the mechanics live here.
#
# Both report on stderr and write only <out>. Return codes:
#   0 the artefact is good
#   1 no artefact (the caller discards <out>)
#   2 VictoriaMetrics only: the artefact is good, but the server-side snapshot
#     could not be deleted (it pins every part it links - say so loudly)
#   3 Loki only: the artefact is good, but Loki did not answer /ready in 90s

bk_snapshot_vm() {  # <container> <out.tar>
  local c=$1 out=$2 resp snap rc=0
  resp=$(bk_vm_api "$c" POST /snapshot/create 2>&1)
  snap=$(printf '%s' "$resp" | sed -n 's/.*"snapshot":"\([^"]*\)".*/\1/p')
  if [ -z "$snap" ]; then
    echo "victoriametrics /snapshot/create failed: $resp" >&2
    return 1
  fi
  docker exec "$c" tar -chf - -C "/victoria-metrics-data/snapshots/$snap" . > "$out" 2>/dev/null
  if tar -tf "$out" 2>/dev/null | grep -c '^\./data/' >/dev/null; then
    echo "victoriametrics: snapshot $snap" >&2
  else
    echo "victoriametrics tar of $snap is unreadable or has no data/" >&2
    rm -f "$out"
    rc=1
  fi
  if ! bk_vm_api "$c" POST "/snapshot/delete?snapshot=$snap" >/dev/null 2>&1; then
    echo "victoriametrics snapshot $snap NOT deleted - POST /snapshot/delete?snapshot=$snap" >&2
    [ "$rc" = 0 ] && rc=2
  fi
  return "$rc"
}

# The CALLER owns "start it again if we die half-way": backup.sh through its
# restart_on_exit trap, scripts/snapshot.sh through its own.
bk_snapshot_loki() {  # <container> <out.tar.gz>
  local c=$1 out=$2 t0
  bk_http "$c" POST http://127.0.0.1:3100/flush </dev/null >/dev/null 2>&1 \
    || echo "loki: /flush did not answer 2xx - continuing; the stop below closes the WAL anyway" >&2
  t0=$(date +%s)
  if ! docker stop -t 60 "$c" >/dev/null; then
    echo "loki would not stop - skipped" >&2
    return 1
  fi
  docker run --rm --volumes-from "$c:ro" "$BK_HELPER_IMAGE" tar -czf - -C /loki . > "$out" 2>/dev/null
  docker start "$c" >/dev/null
  echo "loki: stopped for $(( $(date +%s) - t0 ))s" >&2
  if ! bk_wait 90 bk_http "$c" GET http://127.0.0.1:3100/ready </dev/null; then
    echo "loki restarted but /ready did not answer within 90s" >&2
    return 3
  fi
  return 0
}
