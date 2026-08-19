#!/usr/bin/env bash
# One-glance health check of the whole dev environment.
set -uo pipefail
# BACKUP_ROOT, POSTGRES_USER and the rest, with defaults. See scripts/lib/env.sh
# for why they are derived rather than declared here.
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env.sh"
# `--strict` makes this EXIT NON-ZERO when anything is red. Without it the
# script always exited 0, so it could report a dead Keycloak and a missing backup
# and still look, to anything that reads exit codes, exactly like a clean box -
# which is why CI has never been able to gate on it despite it being the most
# complete picture of the stack in the repo.
#
# OFF BY DEFAULT, deliberately. The everyday use is a human reading the report,
# and for them a non-zero exit adds nothing and makes `just doctor` unusable in a
# shell with `set -e`. The flag exists for the caller that wants a verdict rather
# than a report.
STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1
faults=0

green() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
# Counting lives HERE rather than at each call site: there are 20-odd of them,
# and a verdict that depends on remembering to increment at every one is a
# verdict that is quietly wrong the first time somebody adds a check.
red()   { faults=$((faults + 1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
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
# fiction anyway: the HTML it served linked to hostnames that no longer resolve.
# `portainer` and `dozzle` came out on 2026-08-17: Bothy Control took over
# start/stop/restart and the service pages read logs from Loki, so both were
# stopped. Their compose file is kept - if you start them again, put them back
# here, because a health check that does not know about a service you rely on is
# worse than one that reports it missing. `portal-files` took its slot: it is
# the editor tier, it has no published port, and a health sweep that cannot see
# the one service that can WRITE to the repos is missing the thing worth watching. `portal-next` is the LIVE portal;
# `portal` is the retired nginx one, kept only because its compose file also owns
# portal-socket-proxy. Both run, so both are expected.
# redis/redis-exporter/kafka/kafka-ui/kafka-exporter removed 2026-08-12 - retired
# as idle. Leaving them here made `just doctor` report five phantom absences,
# which is the fastest way to teach someone to ignore the health check.
# keycloak/oauth2-proxy are the identity layer added the same day.
expected="traefik oauth2-proxy keycloak portal-socket-proxy prometheus grafana loki promtail cadvisor node-exporter postgres postgres-exporter portal-next portal-files bothy-config bothy-control bothy-control-socket-read bothy-control-socket-write"
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
  #
  # CARRY lastError, which this filter used to throw away. The targets API has
  # always returned it, alongside lastScrape and lastScrapeDuration, and the
  # report printed "prometheus (down)" - a line with nowhere to go next, so the
  # reader either shrugged or went and ran curl by hand. `down: dial tcp
  # 172.18.0.4:9187: connect: connection refused` names the cause on the line
  # that reports the fault, and it is what separates a target that is broken
  # from one that is merely new. @tsv, not string interpolation: a lastError is
  # a sentence with spaces in it, and the loop below has to be able to tell
  # where the job name ends.
  targets=$(printf 'user = "%s:%s"\n' "${DEV_LOGIN_USER:-}" "${DEV_LOGIN_PASSWORD:-}" \
    | curl -s --max-time 5 --config - \
      'http://localhost:9090/api/v1/targets?state=active' 2>/dev/null \
    | jq -r '.data.activeTargets[]
             | [.labels.job, .health, (.lastError // "")]
             | @tsv' 2>/dev/null | sort -u)
  if [ -z "$targets" ]; then
    red "prometheus returned no targets - up, but unauthenticated? set DEV_LOGIN_* in .env"
  else
    # A HERE-STRING, NOT `echo "$targets" | while`. A pipeline runs its right
    # side in a SUBSHELL, so red()'s `faults=$((faults + 1))` incremented a copy
    # that was thrown away at the end of the loop - two down targets printed in
    # red and `--strict` reported "2 fault(s)" when it should have said 4, and
    # would have exited 0 if these were the only ones. Found on the first fresh
    # install, where several targets are legitimately down.
    #
    # This is the failure mode the counter was put inside red() to avoid, arriving
    # by a different door: not a call site that forgot to count, but one whose
    # count could not escape.
    #
    # THREE states, not two. Prometheus reports a target as `unknown` from the
    # moment it is discovered until the first scrape completes, so seconds after
    # `just up` the self-scrape is `unknown` and the old `= up` test called that
    # a fault. It is not one: it is a target that has not been asked yet, and on
    # a fresh install it is one of four red ✗ that CI wrote off as true
    # statements about a new box. dim() exists for exactly this - see its own
    # comment at the top of this file.
    #
    # `down` stays red, and now says why - which is the half that mattered.
    # Three of those four faults were what CI said they were. The fourth, this
    # one, was NOT: the self-scrape was down on every fresh install because
    # bootstrap chmod 600'd a password file that Prometheus reads as uid 65534,
    # and "prometheus (down)" with nothing after it is indistinguishable from a
    # target nobody has asked yet. It was written off as timing for as long as
    # that line existed. Printing lastError is what found it.
    while IFS=$'\t' read -r j h err; do
      case "$h" in
        up)      green "$j" ;;
        unknown) dim "$j (unknown - not scraped yet)" ;;
        *)       [ -n "$err" ] && red "$j ($h): $err" || red "$j ($h)" ;;
      esac
    done <<< "$targets"
  fi
fi

echo "== kubernetes =="
# The old form attached || to a while loop, whose exit status is zero even when
# kubectl fails, so an unreachable cluster could never actually be reported.
if ! command -v kubectl >/dev/null 2>&1; then
  # dim, NOT red - the same rule the minikube branch below already states, one
  # step earlier in the chain. Nothing in this repo depends on Kubernetes: no
  # compose file, no script, no CI job, and the cluster this section was written
  # for was retired on 2026-08-12. A machine that never installed kubectl is
  # therefore in its expected state, and calling that a fault made `just doctor
  # strict` report a defect on every fresh install for a tool Bothy does not
  # need. Absence is not breakage; it only reads as breakage when the report has
  # no third state to put it in.
  dim "kubectl is not installed - nothing in Bothy needs it"
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
    # A here-string for the same reason the prometheus loop above uses one:
    # `echo | awk | while` ran the loop body in a SUBSHELL, so red()'s increment
    # landed in a copy that was discarded at `done` and a NotReady node could be
    # printed in red while `--strict` still exited 0. Latent rather than
    # observed - it needs a cluster with a node that is not Ready, and this box
    # has had no cluster since 2026-08-12 - but it is the identical bug, and a
    # latent one is only ever a fix away from being the observed one. read's own
    # word splitting replaces the awk; the trailing `_` swallows ROLES, AGE and
    # VERSION.
    while read -r n st _; do
      [ "$st" = Ready ] && green "node $n" || red "node $n ($st)"
    done <<< "$nodes"
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

# How long this box has been up, in whole seconds - the one piece of context
# that separates "the backup timer is broken" from "the backup timer has not
# come round yet", and which this script had none of. /proc/uptime is Linux
# only, so its absence is handled rather than assumed: an UNKNOWN uptime is
# treated as an OLD box below, because the alternative is a check that quietly
# stops being able to fail on any machine that does not publish the file.
uptime_s=""
[ -r /proc/uptime ] && uptime_s=$(cut -d' ' -f1 < /proc/uptime | cut -d. -f1)
case "$uptime_s" in ''|*[!0-9]*) uptime_s="" ;; esac

latest=$(ls -1t "$BACKUP_ROOT"/postgres/*.sql.gz 2>/dev/null | head -1)
if [ -z "$latest" ]; then
  # No dump at all is a different fact at three minutes than at three days.
  # backup.sh runs from a nightly systemd timer at 03:00, so a box younger than
  # one full day may simply never have reached its first run - and reporting
  # that as a fault is how `just doctor strict` came to be unusable on a fresh
  # install, where it was one of four red ✗ attributed to newness. Three of
  # the four, this one included, really were that. The fourth was a genuine
  # bug hiding behind the same excuse - see the note in the target loop above.
  #
  # 86400s, one timer period, deliberately generous: past it the timer has had
  # its chance no matter what hour the box booted, and silence then IS the
  # fault. This branch is the one that must keep working - a permanently dim
  # "no backups yet" would be worse than the cry-wolf it replaces.
  if [ -n "$uptime_s" ] && [ "$uptime_s" -lt 86400 ]; then
    dim "no postgres backups yet - box up $(( uptime_s / 3600 ))h, the nightly timer has not come round"
  else
    red "no postgres backups yet"
  fi
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
  live=$(docker exec postgres psql -U "${POSTGRES_USER:-dev}" -tAc \
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

# ── verdict ──────────────────────────────────────────────────────────────────
echo
# printf, not green/red: red() increments the counter, and a verdict line that
# counts itself is the kind of off-by-one nobody reads twice.
if [ "$faults" -eq 0 ]; then
  printf '  \033[32m✓\033[0m no faults\n'
else
  printf '  \033[31m✗\033[0m %s fault(s) above\n' "$faults"
fi
# Zero unless asked, for the reason at the top of this file.
[ "$STRICT" = 1 ] && exit $(( faults > 0 ? 1 : 0 ))
exit 0
