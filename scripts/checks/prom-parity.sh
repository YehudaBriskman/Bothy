#!/usr/bin/env bash
# Do two Prometheus-API endpoints answer the queries this repo depends on alike?
#
# Written for the Prometheus -> VictoriaMetrics move (2026-09), and kept because
# the question comes back every time the metrics backend, a scrape job or an
# exporter changes: "Bothy's graphs and the Grafana alerts still work" is a claim
# about a fixed list of PromQL expressions, so it is checked against that list
# rather than by eyeballing a dashboard.
#
#   scripts/checks/prom-parity.sh <url-A> <url-B> [window-seconds] [step]
#   scripts/checks/prom-parity.sh http://localhost:9090 http://localhost:8428 300 15
#
# Both endpoints get the same basic auth: DEV_LOGIN_USER / DEV_LOGIN_PASSWORD
# from the environment or ./.env (they are the credentials both Prometheus and
# VictoriaMetrics are configured with). Credentials go to curl on STDIN, never
# argv - the same rule scripts/doctor.sh states at length.
#
# READ-ONLY. Only /api/v1/query_range and /api/v1/query are called.
#
# WHAT "PARITY" MEANS HERE, and what it deliberately forgives:
#
#   · SHAPE: the set of label sets per query must be equal. A label that exists
#     on one side and not the other (a relabel that did not port, a job renamed)
#     is exactly the silent break this exists for, and it fails.
#   · VALUES: every timestamp present on BOTH sides is compared, tolerance 5%
#     relative (or an absolute floor for values near zero, where 5% of nothing is
#     noise). Mean over the window must agree within the same tolerance, and at
#     least 90% of individual points must.
#   · GAPS are forgiven, not compared: a rate() over [2m] has no value until two
#     samples exist, so a freshly started backend is missing the first ~2m of
#     every rate series. The count of one-sided points is printed so a gap that
#     is NOT warm-up (a scrape failing) is still visible.
#   · The backends' own self-scrape jobs (`prometheus`, `victoriametrics`) differ
#     by design, so series with a job in SKIP_JOBS are dropped from both sides
#     before comparing.
#
# END=<epoch> pins the window end (e.g. to the moment an import finished).
#
# Exit 0 when every query passes, 1 otherwise.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

A=${1:?usage: prom-parity.sh <url-A> <url-B> [window-seconds] [step]}
B=${2:?usage: prom-parity.sh <url-A> <url-B> [window-seconds] [step]}
WINDOW=${3:-300}
STEP=${4:-15}
TOL=${TOL:-0.05}
# The two backends' self-scrape jobs are different jobs by design.
SKIP_JOBS=${SKIP_JOBS:-prometheus,victoriametrics}

if [ -z "${DEV_LOGIN_USER:-}" ] && [ -f .env ]; then
  set -a; . ./.env; set +a
fi
: "${DEV_LOGIN_USER:?set DEV_LOGIN_USER (env or .env)}"
: "${DEV_LOGIN_PASSWORD:?set DEV_LOGIN_PASSWORD (env or .env)}"

# Align the window to the step so both backends are asked for the same grid.
NOW=${END:-$(date +%s)}
END=$(( NOW / STEP * STEP - STEP ))
START=$(( END - WINDOW ))

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# name|query - the exact strings apps/bothy-web sends, and the five alert
# expressions from monitoring/provisioning/alerting/rules.yml.
REAL_NIC='device!~"lo|veth.*|docker[0-9]*|br-.*|tailscale.*|virbr.*"'
ROOT_FS='mountpoint="/",fstype!~"tmpfs|overlay|squashfs"'
FS='fstype!~"tmpfs|overlay|squashfs|ramfs"'
cat > "$tmp/queries" <<EOF
bothy:Q_CPU|100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[2m])) * 100)
bothy:Q_MEM|100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)
bothy:Q_NET_RX|sum(rate(node_network_receive_bytes_total{$REAL_NIC}[2m]))
bothy:Q_NET_TX|sum(rate(node_network_transmit_bytes_total{$REAL_NIC}[2m]))
bothy:Q_LOAD|node_load1
bothy:Q_DISK_PCT|100 * (1 - node_filesystem_avail_bytes{$ROOT_FS} / node_filesystem_size_bytes{$ROOT_FS})
bothy:Q_DISK_FREE|node_filesystem_avail_bytes{$ROOT_FS}
bothy:Q_UPTIME|time() - node_boot_time_seconds
bothy:qAllContainerCpu|sum by (name) (rate(container_cpu_usage_seconds_total{name!=""}[2m]))
bothy:qAllContainerMem|sum by (name) (container_memory_working_set_bytes{name!=""})
bothy:SystemDialog.cpu(project)|sum by (name) (rate(container_cpu_usage_seconds_total{container_label_com_docker_compose_project="monitoring"}[2m]))
bothy:SystemDialog.mem(project)|sum by (name) (container_memory_working_set_bytes{container_label_com_docker_compose_project="monitoring"})
bothy:SystemDialog.cpu(names)|sum by (name) (rate(container_cpu_usage_seconds_total{name=~"grafana|loki"}[2m]))
bothy:SystemDialog.mem(names)|sum by (name) (container_memory_working_set_bytes{name=~"grafana|loki"})
alert:target_down|up{job!~"kube.*"}
alert:high_memory|(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100
alert:disk_full|max(100 - (node_filesystem_avail_bytes{$FS} / node_filesystem_size_bytes{$FS}) * 100)
alert:kube_cluster_down|max by (cluster, job) (up{cluster="thales-scc", job=~"kube.*"})
alert:kube_node_not_ready|max by (cluster, node) (kube_node_status_condition{cluster="thales-scc", condition="Ready", status="true"})
EOF

fetch() { # url query out
  printf 'user = "%s:%s"\n' "$DEV_LOGIN_USER" "$DEV_LOGIN_PASSWORD" \
    | curl -s --max-time 30 --config - -G "$1/api/v1/query_range" \
        --data-urlencode "query=$2" --data-urlencode "start=$START" \
        --data-urlencode "end=$END" --data-urlencode "step=$STEP" > "$3"
}

i=0
while IFS='|' read -r name query; do
  [ -n "$name" ] || continue
  i=$((i + 1))
  printf '%s\n%s\n' "$name" "$query" > "$tmp/q$i.meta"
  fetch "$A" "$query" "$tmp/q$i.a"
  fetch "$B" "$query" "$tmp/q$i.b"
done < "$tmp/queries"

python3 - "$tmp" "$i" "$TOL" "$SKIP_JOBS" "$A" "$B" "$START" "$END" "$STEP" <<'PY'
import json, sys, os, math
tmp, n, tol, skip, A, B, start, end, step = sys.argv[1:10]
n, tol = int(n), float(tol)
skip = set(filter(None, skip.split(',')))
print(f"A = {A}\nB = {B}\nwindow {start}..{end} step {step}s, tolerance {tol:.0%}\n")

def load(p):
    try:
        body = json.load(open(p))
    except Exception as e:
        return None, f"not JSON ({e.__class__.__name__})"
    if body.get('status') != 'success':
        return None, body.get('error', 'status != success')
    out = {}
    for s in body['data']['result']:
        m = s.get('metric', {})
        if m.get('job') in skip:
            continue
        key = tuple(sorted(m.items()))
        out[key] = {int(float(t)): float(v) for t, v in s.get('values', []) if v not in ('NaN', '+Inf', '-Inf')}
    return out, None

def close(a, b):
    d = abs(a - b)
    return d <= max(abs(a), abs(b)) * tol or d <= 1e-6 or (max(abs(a), abs(b)) < 1e-3)

rows, failed = [], 0
for k in range(1, n + 1):
    name, query = open(f"{tmp}/q{k}.meta").read().split('\n')[:2]
    a, ea = load(f"{tmp}/q{k}.a")
    b, eb = load(f"{tmp}/q{k}.b")
    if ea or eb:
        rows.append((name, '-', '-', '-', '-', '-', f"FAIL error A={ea} B={eb}")); failed += 1; continue
    only_a = [dict(x) for x in a if x not in b]
    only_b = [dict(x) for x in b if x not in a]
    both = [x for x in a if x in b]
    compared = ok = gaps = 0
    worst = 0.0
    mean_bad = []
    for key in both:
        ta, tb = a[key], b[key]
        common = sorted(set(ta) & set(tb))
        gaps += len(set(ta) ^ set(tb))
        for t in common:
            compared += 1
            if close(ta[t], tb[t]): ok += 1
            den = max(abs(ta[t]), abs(tb[t]))
            if den > 1e-3: worst = max(worst, abs(ta[t] - tb[t]) / den)
        if common:
            ma = sum(ta[t] for t in common) / len(common)
            mb = sum(tb[t] for t in common) / len(common)
            if not close(ma, mb): mean_bad.append((dict(key).get('name') or dict(key).get('job') or str(dict(key)), ma, mb))
    verdict = 'PASS'
    notes = []
    if only_a or only_b:
        verdict = 'FAIL'
        if only_a: notes.append(f"only in A: {only_a[:3]}")
        if only_b: notes.append(f"only in B: {only_b[:3]}")
    if mean_bad:
        verdict = 'FAIL'; notes.append(f"window mean differs: {mean_bad[:3]}")
    # Individual points may straddle a scrape boundary differently (the two
    # backends scrape on their own clocks); a query where most points disagree
    # is not that.
    #
    # EXCEPT for rate(). MetricsQL's rate() deliberately differs from PromQL's:
    # it includes the last sample BEFORE the window and never extrapolates to the
    # window edges, so point-by-point a [2m] rate differs by a few percent (host
    # CPU measured at 3.0% vs 3.4%). The window mean is what a chart reads as the
    # level, and it is still enforced; the per-point spread is reported, not failed.
    is_rate = 'rate(' in query
    if compared and ok / compared < 0.9:
        if is_rate and not mean_bad:
            verdict = 'PASS~'; notes.append(f"rate() semantics: {ok}/{compared} points within tolerance, means agree")
        else:
            verdict = 'FAIL'; notes.append(f"only {ok}/{compared} points within tolerance")
    if not a and not b:
        verdict = 'EMPTY'; notes.append('no series on either side')
    elif compared == 0 and verdict == 'PASS':
        verdict = 'FAIL'; notes.append('no overlapping points')
    pct = f"{100 * ok / compared:.0f}%" if compared else '-'
    if verdict == 'FAIL': failed += 1
    rows.append((name, f"{len(a)}/{len(b)}", str(compared), pct, f"{worst:.1%}", str(gaps), verdict + (' ' + '; '.join(notes) if notes else '')))

w = [max(len(r[i]) for r in rows + [('query', 'series A/B', 'points', 'in tol', 'max diff', 'gaps', 'verdict')]) for i in range(6)]
hdr = ('query', 'series A/B', 'points', 'in tol', 'max diff', 'gaps', 'verdict')
for r in [hdr] + rows:
    print('  '.join(r[i].ljust(w[i]) for i in range(6)) + '  ' + r[6])
print(f"\n{len(rows) - failed}/{len(rows)} queries at parity")
sys.exit(1 if failed else 0)
PY
