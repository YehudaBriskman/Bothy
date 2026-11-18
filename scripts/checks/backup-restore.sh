#!/usr/bin/env bash
# A backup that has never been restored is a hope. This runs the REAL
# scripts/backup.sh and scripts/restore.sh against a throwaway fixture - no
# docker (a stub `docker` that always fails is first on PATH, so every container
# step takes its "not running" branch), no live data (the scripts are copied into
# a temp "repo root", so $root/.env and $root/apps are fixtures), no network.
#
# What it proves, in order:
#   1. the `state` set holds the token store, and `restore state` puts the whole
#      fixture back BYTE-FOR-BYTE with the SAME MODES (tokens 0700 / 0600);
#   2. an archive whose token files were group/world readable comes back 0600;
#   3. restore refuses an archive with a member outside apps/ and bothy/;
#   4. BOTHY_BACKUP_MIRROR: small sets are copied, checksummed, the same
#      retention applies, and a corrupting copier / a git work tree is refused;
#   5. the doctor's verdict function: unset and same-device are NOT ok, a
#      different device is.
#
# Needs bash, tar, python3, git (only to make a fake .git dir it never runs).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.." || exit 1
SRC=$PWD

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0
fail=0
ok()  { printf 'PASS  %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; fail=$((fail + 1)); }

# A stub docker, first on PATH: nothing here may reach a real daemon.
mkdir -p "$T/bin"
printf '#!/bin/sh\nexit 1\n' > "$T/bin/docker"
chmod +x "$T/bin/docker"

# The fake repo root: the real scripts, a fixture .env, fixture audit logs.
ROOT=$T/root
mkdir -p "$ROOT/scripts/lib" "$ROOT/apps/bothy-ops/audit" "$ROOT/apps/bothy-files/audit"
cp "$SRC"/scripts/backup.sh "$SRC"/scripts/restore.sh "$ROOT/scripts/"
cp "$SRC"/scripts/lib/env.sh "$SRC"/scripts/lib/backup-lib.sh "$ROOT/scripts/lib/"
printf 'POSTGRES_PASSWORD=fixture-aaaa\n' > "$ROOT/.env"
printf '{"who":"a"}\n' > "$ROOT/apps/bothy-ops/audit/audit.jsonl"
printf '{"who":"b"}\n' > "$ROOT/apps/bothy-files/audit/audit.jsonl"

# The fixture state dir, with the modes the real store has.
STATE=$T/state
mkdir -p "$STATE/bothy/tokens" "$STATE/bothy/trash/x" "$STATE/bothy/config-trash"
printf '{"tokens":[{"id":"t1","digest":"00ff"}]}\n' > "$STATE/bothy/tokens/tokens.json"
: > "$STATE/bothy/tokens/tokens.lock"
printf 'denied t1\n' > "$STATE/bothy/tokens/audit.log"
printf 'old note\n' > "$STATE/bothy/trash/x/file.md"
printf '{}\n' > "$STATE/bothy/config-trash/c.json"
chmod 700 "$STATE/bothy/tokens"
chmod 600 "$STATE/bothy/tokens/"*
chmod 644 "$STATE/bothy/trash/x/file.md"

NOTES=$T/notes; mkdir -p "$NOTES"; printf 'n\n' > "$NOTES/a.md"

# run_backup <backup-root> [extra env...]  (never the caller's HOME or real roots)
run_backup() {
  local bk=$1; shift
  env -i PATH="$T/bin:$PATH" HOME="$T/home" STATE_ROOT="$STATE" NOTES_ROOT="$NOTES" \
    BACKUP_ROOT="$bk" "$@" bash "$ROOT/scripts/backup.sh" "$bk" >"$T/backup.out" 2>&1
}
run_restore() {  # <file> <apps-target> <state-target> <backup-root>
  env -i PATH="$T/bin:$PATH" HOME="$T/home" STATE_ROOT="$T/never" NOTES_ROOT="$NOTES" \
    BACKUP_ROOT="$4" BK_APPS_TARGET="$2" BK_STATE_TARGET="$3" \
    bash "$ROOT/scripts/restore.sh" state "$1" --yes >"$T/restore.out" 2>&1
}

# tree_sig <base> <subdir>...: relpath, type, mode, and sha256 of every entry
# under each subdir (the archived members; the parents tar never stored are not
# compared), sorted.
tree_sig() {
  python3 -I - "$@" <<'PY'
import hashlib, os, stat, sys
base = sys.argv[1]
rows = []
for sub in sys.argv[2:]:
  top = os.path.join(base, sub)
  st = os.lstat(top)
  rows.append("%s d %o -" % (sub, stat.S_IMODE(st.st_mode)))
  for d, dirs, files in os.walk(top):
    for n in dirs + files:
        p = os.path.join(d, n)
        st = os.lstat(p)
        h = hashlib.sha256(open(p, "rb").read()).hexdigest() if stat.S_ISREG(st.st_mode) else "-"
        rows.append("%s %s %o %s" % (os.path.relpath(p, base), "d" if stat.S_ISDIR(st.st_mode) else "f", stat.S_IMODE(st.st_mode), h))
print("\n".join(sorted(rows)))
PY
}

# ── 1. backup, then restore elsewhere, byte for byte ─────────────────────────
BK=$T/bk1
run_backup "$BK"
ARC=$(ls -1 "$BK"/state/state-*.tar.gz 2>/dev/null | head -1)
if [ -n "$ARC" ] && tar -tzf "$ARC" | grep -q '^bothy/tokens/tokens.json$'; then
  ok "the state archive holds the token store"
else bad "the state archive holds the token store" "$(tar -tzf "${ARC:-/dev/null}" 2>&1 | head; tail -5 "$T/backup.out")"; fi

R_APPS=$T/r1-apps R_STATE=$T/r1-state
if run_restore "$ARC" "$R_APPS" "$R_STATE" "$T/r1-bk"; then ok "restore state exits 0"
else bad "restore state exits 0" "$(tail -5 "$T/restore.out")"; fi

A="apps/bothy-ops/audit apps/bothy-files/audit"
want=$(tree_sig "$ROOT" $A)
got=$(tree_sig "$R_APPS" $A)
[ "$want" = "$got" ] && ok "audit logs restored byte-for-byte, same modes" \
  || bad "audit logs restored byte-for-byte, same modes" "$(diff <(echo "$want") <(echo "$got") | head -5)"
B="bothy/tokens bothy/trash bothy/config-trash"
want=$(tree_sig "$STATE" $B)
got=$(tree_sig "$R_STATE" $B)
[ "$want" = "$got" ] && ok "token store and trash restored byte-for-byte, same modes" \
  || bad "token store and trash restored byte-for-byte, same modes" "$(diff <(echo "$want") <(echo "$got") | head -5)"
m=$(stat -c %a "$R_STATE/bothy/tokens" 2>/dev/null || stat -f %Lp "$R_STATE/bothy/tokens")
[ "$m" = 700 ] && ok "token directory is 0700 after restore" || bad "token directory is 0700 after restore" "got $m"

# ── 2. an archive with loose modes does not widen the token store ────────────
chmod 755 "$STATE/bothy/tokens"; chmod 644 "$STATE/bothy/tokens/tokens.json"
run_backup "$T/bk2"
ARC2=$(ls -1 "$T"/bk2/state/state-*.tar.gz | head -1)
run_restore "$ARC2" "$T/r2-apps" "$T/r2-state" "$T/r2-bk"
m1=$(stat -c %a "$T/r2-state/bothy/tokens" 2>/dev/null); m2=$(stat -c %a "$T/r2-state/bothy/tokens/tokens.json" 2>/dev/null)
if [ "$m1" = 700 ] && [ "$m2" = 600 ]; then ok "a loose-mode archive is restored 0700/0600"
else bad "a loose-mode archive is restored 0700/0600" "dir $m1, file $m2"; fi
chmod 700 "$STATE/bothy/tokens"; chmod 600 "$STATE/bothy/tokens/tokens.json"

# ── 3. an archive that is not a state archive is refused, nothing written ────
mkdir -p "$T/evil/etc"; printf 'x\n' > "$T/evil/etc/passwd"
tar -czf "$T/evil.tar.gz" -C "$T/evil" etc
run_restore "$T/evil.tar.gz" "$T/r3-apps" "$T/r3-state" "$T/r3-bk"; rc=$?
# 2 and the word REFUSED: refused up front, not a late verification failure.
if [ "$rc" != 2 ] || ! grep -q 'REFUSED' "$T/restore.out"; then
  bad "a member outside apps/ and bothy/ is refused" "rc=$rc $(tail -2 "$T/restore.out")"
elif [ ! -e "$T/r3-state/etc" ] && [ ! -e "$T/r3-apps/etc" ]; then ok "a member outside apps/ and bothy/ is refused"
else bad "a member outside apps/ and bothy/ is refused" "it wrote something"; fi

# ── 4. the mirror ────────────────────────────────────────────────────────────
MIR=$T/mirror
run_backup "$T/bk4" BOTHY_BACKUP_MIRROR="$MIR"
bad_copy=0
for d in env state notes; do
  for f in "$T"/bk4/$d/*; do
    [ -f "$f" ] || continue
    b=$(basename "$f")
    if [ -f "$MIR/$d/$b" ] && cmp -s "$f" "$MIR/$d/$b"; then :; else bad_copy=1; fi
  done
done
[ "$bad_copy" = 0 ] && [ -f "$MIR/state/$(basename "$(ls -1 "$T"/bk4/state/state-*.tar.gz | head -1)")" ] \
  && ok "the small sets are copied to the mirror, identical" \
  || bad "the small sets are copied to the mirror, identical" "$(tail -8 "$T/backup.out")"
[ -z "$(find "$MIR" -name '.*tmp*')" ] && ok "no temp file is left on the mirror" \
  || bad "no temp file is left on the mirror"
m=$(stat -c %a "$MIR/env" "$MIR"/env/env-* 2>/dev/null | sort -u | tr '\n' ' ')
[ "$m" = "600 700 " ] && ok "the mirror is 0700 dir, 0600 files" || bad "the mirror is 0700 dir, 0600 files" "got: $m"
[ ! -e "$MIR/victoriametrics" ] && [ ! -e "$MIR/loki" ] && ok "the big sets are not mirrored" || bad "the big sets are not mirrored"

# retention: the mirror keeps what the primary keeps, and nothing it does not own
mkdir -p "$MIR/env"
for i in 01 02 03; do printf 'old\n' > "$MIR/env/env-2020010${i}-000000"; done
printf 'keep me\n' > "$MIR/env/unrelated.txt"
touch -d '2020-01-01' "$MIR"/env/env-2020010*
sleep 1
run_backup "$T/bk4b" BOTHY_BACKUP_MIRROR="$MIR" BK_KEEP=2
n=$(ls -1 "$MIR"/env/env-2* | wc -l)
if [ "$n" = 2 ] && [ -f "$MIR/env/unrelated.txt" ]; then ok "mirror retention follows BK_KEEP and leaves foreign files alone"
else bad "mirror retention follows BK_KEEP and leaves foreign files alone" "$n env files; $(ls "$MIR/env")"; fi

# a copy that does not match its source never gets a real name
printf '#!/bin/sh\ncp -p "$1" "$2" && printf x >> "$2"\n' > "$T/badcp"; chmod +x "$T/badcp"
run_backup "$T/bk5" BOTHY_BACKUP_MIRROR="$T/mirror5" BK_MIRROR_CP="$T/badcp"; rc=$?
if [ "$rc" != 0 ] && ! ls "$T"/mirror5/env/env-* >/dev/null 2>&1 && [ -z "$(find "$T/mirror5" -name '.*tmp*')" ]; then
  ok "a corrupted copy is rejected by its checksum and removed"
else bad "a corrupted copy is rejected by its checksum and removed" "rc=$rc $(ls -A "$T"/mirror5/env 2>&1)"; fi

# never a git work tree
mkdir -p "$T/repo/.git" "$T/repo/sub"
run_backup "$T/bk6" BOTHY_BACKUP_MIRROR="$T/repo/sub/m"; rc=$?
if [ "$rc" != 0 ] && [ ! -e "$T/repo/sub/m" ]; then ok "a mirror inside a git work tree is refused"
else bad "a mirror inside a git work tree is refused" "rc=$rc"; fi

# ── 5. the doctor's verdict ──────────────────────────────────────────────────
# shellcheck disable=SC1091
. "$SRC/scripts/lib/backup-lib.sh"
s=$(bk_mirror_status "" "$T/bk1");           [ "$s" = unset ]       && ok "mirror unset -> unset (amber)"        || bad "mirror unset -> unset (amber)" "$s"
s=$(bk_mirror_status "$T/anything" "$T/bk1"); [ "$s" = same-device ] && ok "same device -> same-device (amber)"   || bad "same device -> same-device (amber)" "$s"
s=$(bk_mirror_status "$T/repo/m" "$T/bk1");   [ "$s" = in-git ]      && ok "inside a git tree -> in-git (red)"    || bad "inside a git tree -> in-git (red)" "$s"
# A second device cannot be conjured in CI, so ask the function with a stub dev.
bk_dev() { case "$1" in "$T"/farmirror*) echo 99999 ;; *) echo 1 ;; esac; }
s=$(bk_mirror_status "$T/farmirror" "$T/bk1"); [ "$s" = ok ]         && ok "a different device -> ok (green)"     || bad "a different device -> ok (green)" "$s"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
