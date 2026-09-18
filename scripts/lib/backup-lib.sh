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
