#!/usr/bin/env bash
# One-glance health check of the whole dev environment.
set -uo pipefail
green() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
red()   { printf '  \033[31m✗\033[0m %s\n' "$*"; }
# Neither a pass nor a fault: something deliberately switched off. Without this
# third state, every retired service reads as breakage and the report cries wolf.
dim()   { printf '  \033[2m·\033[0m %s\n' "$*"; }

echo "== containers =="
# traefik, oauth2-proxy and portal-socket-proxy are the front door and the login
# for everything else, and were missing from this list entirely.
#
# `wiki` was retired and replaced by Bothy Files - it sat here reporting a
# permanent red ✗ that had to be explained away every single sweep, which is how
# a health check teaches you to ignore it. `portal` - the original pure-HTML
# nginx portal, retired behind traefik.enable=false and kept as a rollback - was
# deleted on 2026-08-17 and comes out of this list with it. The rollback was a
# fiction anyway: the HTML it served linked to hostnames that no longer resolve. `portal-files` took its slot: it is
# the editor tier, it has no published port, and a health sweep that cannot see
# the one service that can WRITE to the repos is missing the thing worth watching. `portal-next` is the LIVE portal;
# `portal` is the retired nginx one, kept only because its compose file also owns
# portal-socket-proxy. Both run, so both are expected.
# redis/redis-exporter/kafka/kafka-ui/kafka-exporter removed 2026-08-12 - retired
# as idle. Leaving them here made `just doctor` report five phantom absences,
# which is the fastest way to teach someone to ignore the health check.
# keycloak/oauth2-proxy are the identity layer added the same day.
expected="traefik oauth2-proxy keycloak portal-socket-proxy prometheus grafana loki promtail cadvisor node-exporter postgres postgres-exporter portainer dozzle portal-next portal-files bothy-config bothy-control bothy-control-socket-read bothy-control-socket-write"
for c in $expected; do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  [ "$st" = running ] && green "$c" || red "$c ($st)"
done

echo "== prometheus targets =="
# Without this guard a missing jq piped its failure into a loop that never
# iterated, so an absent dependency read exactly like a clean bill of health.
if ! command -v jq >/dev/null 2>&1; then
  red "jq is not installed - cannot read prometheus targets"
else
  # Prometheus has required basic auth since 2026-08-08 (monitoring/prometheus-web.yml).
  # Without credentials this curl gets 401, jq yields nothing, and the check
  # reported "is it up?" about a server that was up the whole time - a probe
  # that could only ever fail one way.
  # Credentials go in on STDIN, not on the command line.
  #
  # Passing them with curl's inline credential flag puts the password in argv,
  # where any other user on the box can read it out of `ps` or
  # /proc/<pid>/cmdline for as long as the process lives. (The pattern is spelled
  # out nowhere in this file on purpose: gitleaks matches the shape, so writing
  # the example literally would leave a permanent false positive behind in the
  # very check that fixed it.)
  # This box is single-user so the practical exposure is nil, but
  # the habit is the point - and gitleaks flags the pattern, correctly, without
  # being able to tell that these are shell variables rather than a literal.
  # Suppressing the finding would have taught the scanner to stay quiet about the
  # real thing; --config - fixes the actual property it is complaining about.
  targets=$(printf 'user = "%s:%s"\n' "${DEV_LOGIN_USER:-}" "${DEV_LOGIN_PASSWORD:-}" \
    | curl -s --max-time 5 --config - \
      'http://localhost:9090/api/v1/targets?state=active' 2>/dev/null \
    | jq -r '.data.activeTargets[] | "\(.labels.job) \(.health)"' 2>/dev/null | sort -u)
  if [ -z "$targets" ]; then
    red "prometheus returned no targets - up, but unauthenticated? set DEV_LOGIN_* in .env"
  else
    echo "$targets" | while read -r j h; do
      [ "$h" = up ] && green "$j" || red "$j ($h)"
    done
  fi
fi

echo "== kubernetes =="
# The old form attached || to a while loop, whose exit status is zero even when
# kubectl fails, so an unreachable cluster could never actually be reported.
if ! command -v kubectl >/dev/null 2>&1; then
  red "kubectl is not installed"
else
  # minikube was retired on 2026-08-12 - 1,046 MB for zero non-system pods over
  # 27 days. Stopped AND deleted: `minikube profile list` reports no profile, so
  # `minikube start` builds a NEW empty cluster rather than resuming the old one.
  # This comment said "not deleted; `minikube start` brings it back" for a few
  # hours after the delete, which would have promised somebody their workloads
  # back. Absence is the expected state and must not read as a fault, or
  # `just doctor` cries wolf every run and stops being read at all.
  nodes=$(kubectl get nodes --no-headers 2>/dev/null || true)
  if [ -z "$nodes" ]; then
    dim "minikube retired 2026-08-12 - deleted, not stopped ('minikube start' builds a new empty cluster)"
  else
    echo "$nodes" | awk '{print $1, $2}' | while read -r n st; do
      [ "$st" = Ready ] && green "node $n" || red "node $n ($st)"
    done
  fi
fi

echo "== disk / memory =="
df -h / | awk 'NR==2{printf "  / used %s (%s free)\n", $5, $4}'
free -h | awk '/Mem:/{printf "  mem used %s / %s\n", $3, $2}'

echo "== backups =="
# Existence alone is not health. Six days of 20-byte empty dumps passed the old
# check unnoticed, because a failed pg_dumpall still leaves behind a perfectly
# valid gzip of nothing. Age and size are what separate a backup from a file
# that is merely named like one.
latest=$(ls -1t /home/devssh/backups/postgres/*.sql.gz 2>/dev/null | head -1)
if [ -z "$latest" ]; then
  red "no postgres backups yet"
else
  size=$(wc -c < "$latest")
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$latest") ) / 3600 ))
  if [ "$size" -lt 1000 ]; then
    red "latest pg dump is ${size}B - almost certainly empty: $(basename "$latest")"
  elif [ "$age_h" -gt 48 ]; then
    red "latest pg dump is ${age_h}h old: $(basename "$latest")"
  else
    green "latest pg dump: $(basename "$latest") (${size}B, ${age_h}h old)"
  fi

  # COVERAGE, not just freshness.
  #
  # On 2026-08-12 the keycloak database - the box's entire identity layer - was
  # absent from every dump on disk, while this section reported a fresh,
  # correctly-sized backup in green. Both facts were true: the dump was healthy,
  # and it did not contain keycloak, because the database was created hours after
  # the last nightly run.
  #
  # Age and size cannot catch that, and neither can anything else that looks only
  # at the file. A dump that silently stopped including a database would keep
  # passing forever - the same "check that cannot fail" this repo has now been
  # bitten by four times. So compare what the server HAS against what the dump
  # CONTAINS, which is the only question that can actually come back false.
  #
  # backup.sh uses pg_dumpall deliberately for exactly this reason; this check is
  # what would notice if anyone ever narrowed it to a list.
  live=$(docker exec postgres psql -U dev -tAc \
    "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres';" 2>/dev/null | tr -d '\r')
  if [ -n "$live" ]; then
    # Read the dump's database list ONCE, then compare in-shell.
    #
    # The obvious spelling - `zcat "$latest" | grep -q "^CREATE DATABASE $db"`
    # per database - is WRONG under this script's `set -o pipefail`, and wrong in
    # the most misleading direction. grep -q exits the instant it matches, zcat
    # dies of SIGPIPE, and the pipeline's status is therefore non-zero *because
    # the database was found*. Every database present reported as missing.
    #
    # It is the same shape as every other bug this file has caught: not a check
    # that failed to run, but one that ran and confidently said the opposite of
    # the truth. Reading the list once avoids depending on a pipeline's exit
    # status for a question about its output, and it also stops re-decompressing
    # the whole dump once per database.
    dumped=$(zcat "$latest" 2>/dev/null | sed -n 's/^CREATE DATABASE \([a-zA-Z0-9_]*\).*/\1/p')
    missing=""
    for db in $live; do
      case " $(echo "$dumped" | tr '\n' ' ') " in
        *" $db "*) ;;
        *) missing="$missing $db" ;;
      esac
    done
    if [ -n "$missing" ]; then
      red "latest dump is MISSING:$missing (present in postgres, absent from the backup)"
    else
      green "dump covers every database: $(echo "$live" | tr '\n' ' ')"
    fi
  fi
fi
