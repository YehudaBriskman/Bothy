#!/usr/bin/env bash
# scripts/redact-logs.py, against fixtures.
#
# It stands between a failed CI run's logs and a public artifact. Its two jobs
# are "remove every generated secret" and "when that cannot be proven, leave
# NOTHING to upload" - the second is the one that was decorative until
# 2026-11-02 (see the script's header), so most rows here are about it.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.." || exit 1

REDACT="$PWD/scripts/redact-logs.py"
KEYS="$PWD/scripts/lib/bootstrap-keys.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0
fail=0

ok()  { printf 'PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; fail=$((fail + 1)); }

# fresh <name>: a case directory with an .env of five distinct secrets.
# LOW-ENTROPY ON PURPOSE. Random-looking fixtures trip gitleaks' generic-api-key
# rule (it did, on the PR that added this file), and an ignore entry would be a
# hole in a scanner this repo says must not be softened. "fixture" plus a run of
# one letter is unmistakably fake and still exercises every row.
fresh() {
  d="$T/$1"
  mkdir -p "$d/logs"
  cat > "$d/.env" <<'ENV'
# a comment
POSTGRES_PASSWORD=pg-fixture-aaaaaaaaaaaaaaaaaaaa
DEV_LOGIN_PASSWORD=dev-fixture-bbbbbbbbbbbbbbbbbbb
OAUTH2_COOKIE_SECRET=cookie-fixture-cccccccccccccccc
KEYCLOAK_DB_PASSWORD=kcdb-fixture-ddddddddddddddddd
KEYCLOAK_OAUTH2_CLIENT_SECRET=kccs-fixture-eeeeeeeeeeeeeee
GRAFANA_PASSWORD=admin
ENV
}
# setenv KEY VALUE: rewrite one line of the case's .env. Not an in-place sed,
# whose flag differs between GNU sed and the BSD sed a Mac ships.
setenv() {
  awk -v k="$1" -v v="$2" 'index($0, k "=") == 1 { print k "=" v; next } { print }' \
    "$d/.env" > "$d/.env.new" && mv "$d/.env.new" "$d/.env"
}
run() { python3 -I "$REDACT" "$d/logs" "$d/.env" "${1:-$KEYS}" >"$d/out" 2>&1; }
only_refused() { [ "$(find "$d/logs" -mindepth 1 | wc -l)" = 1 ] && [ -f "$d/logs/REFUSED.txt" ]; }

# 1. The ordinary case.
fresh plain
printf 'connecting with pg-fixture-aaaaaaaaaaaaaaaaaaaa\nok\n' > "$d/logs/postgres.log"
if run && ! grep -q 'pg-fixture-aaaa' "$d/logs/postgres.log" \
       && grep -q '<POSTGRES_PASSWORD redacted>' "$d/logs/postgres.log"; then
  ok "a secret in a log is replaced by its key name"
else bad "a secret in a log is replaced by its key name" "$(cat "$d/out")"; fi

# 2. Every file, at any depth.
fresh deep
mkdir -p "$d/logs/a/b"
echo 'cookie-fixture-cccccccccccccccc' > "$d/logs/a/b/x.txt"
if run && ! grep -rq 'cookie-fixture-cccc' "$d/logs"; then ok "a nested file is redacted too"
else bad "a nested file is redacted too" "$(cat "$d/out")"; fi

# 3. Longest first. A value containing another must go whole, not leave a
#    fragment around a placeholder.
fresh nested
setenv POSTGRES_PASSWORD wrap-dev-fixture-bbbbbbbbbbbbbbbbbbb-wrap
printf 'wrap-dev-fixture-bbbbbbbbbbbbbbbbbbb-wrap' > "$d/logs/x.log"
if run && [ "$(cat "$d/logs/x.log")" = '<POSTGRES_PASSWORD redacted>' ]; then
  ok "a secret containing another is removed whole"
else bad "a secret containing another is removed whole" "got: $(cat "$d/logs/x.log")"; fi

# 4. A value that is not a generated secret is left alone (GRAFANA_PASSWORD is
#    `admin`; redacting it would mangle every log that says "admin").
fresh other
echo 'user admin logged in' > "$d/logs/g.log"
if run && grep -q 'user admin logged in' "$d/logs/g.log"; then ok "a value that is not generated is not touched"
else bad "a value that is not generated is not touched" "$(cat "$d/logs/g.log")"; fi

# 5. The key list cannot be read: nothing may be uploaded.
fresh nokeys
echo 'pg-fixture-aaaaaaaaaaaaaaaaaaaa' > "$d/logs/postgres.log"
if ! run "$d/does-not-exist" && only_refused; then ok "no key list -> the directory is emptied"
else bad "no key list -> the directory is emptied" "$(ls -R "$d/logs")"; fi

# 6. The key list is prose (the unanchored-regex bug): same.
fresh prose
printf '# SECRET_KEYS="these are not keys at all"\nSECRET_KEYS="lower case words"\n' > "$d/keys.sh"
echo 'pg-fixture-aaaaaaaaaaaaaaaaaaaa' > "$d/logs/postgres.log"
if ! run "$d/keys.sh" && only_refused; then ok "a key list of prose -> the directory is emptied"
else bad "a key list of prose -> the directory is emptied" "$(ls -R "$d/logs")"; fi

# 7. No .env: same - it cannot know what to remove.
fresh noenv
rm "$d/.env"
echo 'anything' > "$d/logs/x.log"
if ! run && only_refused; then ok "no .env -> the directory is emptied"
else bad "no .env -> the directory is emptied" "$(ls -R "$d/logs")"; fi

# 8. The verification is real. DEV_LOGIN's placeholder rebuilds POSTGRES's
#    value after POSTGRES was already handled (longest first), so a secret is
#    present after redaction. Contrived - but it is the only way to prove the
#    "prove it" pass runs and that its refusal leaves nothing behind.
fresh leak
setenv POSTGRES_PASSWORD 'Z<DEV_LOGIN_PASSWORD redacted>'
setenv DEV_LOGIN_PASSWORD bbbbbbbb
echo 'Zbbbbbbbb' > "$d/logs/x.log"
if ! run && only_refused && grep -q 'POSTGRES_PASSWORD' "$d/logs/REFUSED.txt" \
     && ! grep -q 'bbbbbbbb' "$d/logs/REFUSED.txt"; then
  ok "a secret left after redaction -> emptied, and the note names the key only"
else bad "a secret left after redaction -> emptied, and the note names the key only" "$(cat "$d/out"; ls -R "$d/logs")"; fi

# 9. Nothing collected is not an error.
fresh empty
if run; then ok "an empty log directory is fine"; else bad "an empty log directory is fine" "$(cat "$d/out")"; fi

echo
echo "$pass pass · $fail fail"
[ "$fail" -eq 0 ]
