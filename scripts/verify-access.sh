#!/usr/bin/env bash
# Verify the box's access model still holds.  `just verify`
#
# Written on 2026-08-12 to check that retiring the *.dev.test name layer changed
# exactly what it was meant to, and kept because those are the same properties
# worth re-checking after ANY edge change: services reachable on their own ports,
# the portal and its data plane up, no Host() rules, no config leak, the
# socket-proxy boundary intact, no dynamic file silently voided.
#
# Every check below can FAIL - that is the point. A check that passes whether or
# not the change worked is not a check (docs/brand/quality/qa-and-verification.md).
# Where a probe's ability to fail is not obvious, it is demonstrated: check 6
# proves it can tell an allowed endpoint from a blocked one, and check 5b has a
# self-test behind VERIFY_SELFTEST=1 that voids a file on purpose.
#
# Run AFTER `docker compose ... up -d` has applied the edits.
set -uo pipefail
IP=100.117.176.85
pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
code() { curl -s -o /dev/null -m 4 -w '%{http_code}' "$@" 2>/dev/null || echo 000; }

echo "== 1. Services must still be reachable at IP:port (unchanged from baseline) =="
# name:port:expected - expected taken from the pre-change baseline, not invented.
# kafka-ui:8081 was removed from this list on 2026-08-12 when kafka was retired
# as idle (0 topics). Leaving it here would fail forever and turn a green harness
# into a red one nobody reads - the same failure this repo just fixed in doctor.sh.
for e in grafana:3000:302 prometheus:9090:401 dozzle:8080:307 \
         cadvisor:8082:307 portainer:9000:200 loki:3100:404 node-exporter:9100:200; do
  n=${e%%:*}; rest=${e#*:}; p=${rest%%:*}; want=${rest##*:}
  got=$(code "http://$IP:$p/")
  [ "$got" = "$want" ] && ok "$n :$p -> $got" || bad "$n :$p -> $got (baseline was $want)"
done

echo
echo "== 2. The portal and its APIs must still work on the bare IP =="
for u in "/" "/-/api/traefik/http/routers" "/-/api/docker/containers/json" "/-/api/prom/query?query=up"; do
  got=$(code "http://$IP$u")
  [ "$got" = "200" ] && ok "$u -> 200" || bad "$u -> $got (expected 200)"
done
# The portal must be the SPA, not an error page.
if curl -s -m 4 "http://$IP/" | grep -q '<title>Bothy'; then ok "bare IP serves the Bothy SPA"; else bad "bare IP is not serving the SPA"; fi

echo
echo "== 3. THE LEAK: the Traefik dashboard/API must no longer be routed =="
raw=$(curl -s -m 4 -H 'Host: traefik.dev.test' "http://$IP/api/rawdata")
if echo "$raw" | head -c 200 | grep -qi '<!doctype html'; then
  ok "/api/rawdata now falls through to the SPA (no config dump)"
elif [ -z "$raw" ]; then
  ok "/api/rawdata returns nothing"
else
  bad "/api/rawdata STILL returns config: $(echo "$raw" | head -c 120)"
fi
# The specific thing that was leaking.
if echo "$raw" | grep -qi '"authorization"'; then
  bad "an Authorization header is STILL exposed via /api/rawdata"
else
  ok "no Authorization header exposed"
fi

echo
echo "== 4. No dev.test router may remain in Traefik =="
left=$(curl -s -m 4 "http://$IP/-/api/traefik/http/routers" \
  | python3 -c 'import sys,json;print(" ".join(r["name"] for r in json.load(sys.stdin) if "dev.test" in r.get("rule","")))' 2>/dev/null)
[ -z "$left" ] && ok "zero dev.test routers" || bad "still present: $left"

echo
echo "== 5. No router may be in an error/disabled state =="
broken=$(curl -s -m 4 "http://$IP/-/api/traefik/http/routers" \
  | python3 -c 'import sys,json;print(" ".join(r["name"] for r in json.load(sys.stdin) if r.get("status")!="enabled"))' 2>/dev/null)
[ -z "$broken" ] && ok "every router enabled" || bad "not enabled: $broken"

echo
echo "== 5b. No dynamic file may have failed to parse =="
# Check 5 above CANNOT catch this, and that is the whole reason 5b exists.
#
# Files in edge/dynamic/ are rendered as Go templates, so a doubled brace `{{`
# anywhere - INCLUDING INSIDE A COMMENT - voids the entire file. Traefik then
# keeps serving its last-good configuration, so the router table is unchanged and
# every router still reports `enabled`. Verified on 2026-08-12 by voiding a file
# on purpose: 7 routers before, 7 routers after, zero difference in the API.
#
# The damage is deferred, not avoided. The next time Traefik restarts it has no
# last-good config to fall back on, and every @file router disappears at once -
# which on this box is the portal's entire /-/api/* data plane.
#
# The log is the only place the failure is visible, so that is what this reads.
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx traefik; then
  bad "traefik container not running - cannot check for template errors"
else
  # Force a re-parse first, then read a SHORT window.
  #
  # Scanning the last N minutes of log answers "was a file ever broken", which is
  # not the question - it goes red for an error that has since been fixed, and it
  # stays green for a file broken N+1 minutes ago and still broken now. Touching
  # every dynamic file makes the provider re-read them, so what lands in the next
  # few seconds is the CURRENT state and nothing else. touch changes only mtime.
  touch edge/dynamic/*.yml 2>/dev/null
  sleep 4
  errs=$(docker logs traefik --since 6s 2>&1 \
    | grep -iE 'collecting file configs|unclosed action|function .* not defined' | tail -3)
  if [ -z "$errs" ]; then
    ok "every dynamic file re-parsed cleanly just now"
  else
    bad "a dynamic file fails to parse (routers still look fine until restart):"
    printf '        %s\n' "$errs"
  fi
fi

# Prove this probe can actually fail, rather than trusting that it would.
# A check nobody has ever seen go red is a check nobody should believe.
if [ "${VERIFY_SELFTEST:-}" = "1" ]; then
  echo "        [selftest] voiding a file on purpose..."
  probe=edge/dynamic/_selftest.yml
  printf '# {{ selftest\n' > "$probe"
  sleep 4
  if docker logs traefik --since 15s 2>&1 | grep -qiE 'collecting file configs|_selftest'; then
    ok "selftest: the probe DOES detect a voided file"
  else
    bad "selftest: the probe did NOT detect a voided file - check 5b proves nothing"
  fi
  rm -f "$probe"
  sleep 2
fi

echo
echo "== 5c. The sandbox origin must serve BYTES ONLY =="
# :8100 exists so a hostile SVG or PDF runs on a different ORIGIN and therefore
# cannot read the portal DOM or the JSON API's responses. That property is worth
# exactly as much as this check: if anything else ever answers there - the SPA, a
# JSON route, an oauth2 page - the isolation is silently gone and every page will
# still look fine.
#
# Note this asserts 404, and here that IS sound: :8100 has NO catch-all, which is
# the whole point. On :80 a 404 would be impossible (the portal answers
# everything), which is why check 6 below has to assert content instead.
for p in "/" "/-/api/traefik/http/routers" "/-/api/docker/containers/json" "/oauth2/sign_in"; do
  got=$(code "http://$IP:8100$p")
  [ "$got" = "404" ] && ok "sandbox 404s $p" || bad "sandbox served $p -> $got (must be 404)"
done
# ...and the two routes that SHOULD be there are routed and gated.
got=$(code "http://$IP:8100/-/api/files/raw?root=stacks&path=README.md")
[ "$got" = "401" ] && ok "sandbox routes /raw, gated (401 unauthenticated)" \
                   || bad "sandbox /raw -> $got (expected 401)"
# The portal origin must NOT serve raw bytes. It answers 200 with the SPA
# because of the catch-all, so this asserts CONTENT, not status.
if curl -s -m 4 "http://$IP/-/api/files/raw?root=stacks&path=README.md" | grep -q '<title>Bothy'; then
  ok "raw is NOT routed on the portal origin (falls through to the SPA)"
else
  bad "the portal origin served something for /raw - the sandbox split is broken"
fi

echo
echo "== 6. The socket-proxy boundary must still hold =="
# Test the CONTENT TYPE, not the status. The portal owns a catch-all
# PathPrefix(`/`) router, so an UNROUTED path returns 200 with the SPA's HTML -
# a status-code check reports "reachable" for something that is in fact blocked,
# which is exactly what this check did on its first run.
cid=$(docker ps -q | head -1)
ctype() { curl -s -m 4 -o /dev/null -w '%{content_type}' "$1" 2>/dev/null; }

blocked=$(ctype "http://$IP/-/api/docker/containers/$cid/json")
case "$blocked" in
  *json*) bad "per-container endpoint served JSON - boundary broken, container Env is exposed" ;;
  *)      ok  "per-container endpoint blocked (falls through to the SPA: $blocked)" ;;
esac

# The other half: prove the probe can tell the two apart. If the allowed
# endpoint is NOT json, the check above would pass for the wrong reason.
allowed=$(ctype "http://$IP/-/api/docker/containers/json")
case "$allowed" in
  *json*) ok  "allowed endpoint still serves JSON - the probe can distinguish" ;;
  *)      bad "allowed endpoint returned $allowed - probe is broken, check 6 proves nothing" ;;
esac

echo
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
