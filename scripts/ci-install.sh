#!/usr/bin/env bash
# Reproduce the Install job locally, inside docker-in-docker. `just ci-install`
#
# WHY THIS EXISTS. A CI job you can only debug by pushing is its own cry-wolf:
# the loop is ten minutes long, the state is gone when it ends, and the temptation
# is to guess. Everything else in this repo can be run by hand; this is the one
# job that could not be, and it is also the longest and the most likely to fail
# for an environmental reason.
#
# WHY DOCKER-IN-DOCKER AND NOT JUST A CLONE IN /tmp. Every compose file in this
# repo pins a top-level `name:` - edge, auth, monitoring, bothy - and compose
# project names are GLOBAL TO THE DAEMON, not scoped to a directory. A clone in
# /tmp running `just up` therefore does not start a second copy of Bothy: it
# ADOPTS the one already running and recreates its containers from the clone's
# files. That is not hypothetical. It happened here, from a warning message that
# contained backticks inside a double-quoted string, and it recreated traefik and
# keycloak from /tmp against the real daemon.
#
# So: a separate daemon, in a container, with its own storage. The clone inside
# it can call its stacks whatever it likes.
#
# COMPOSE_PROJECT_NAME is NOT the answer, before anyone tries it. It does
# override a file's `name:` - but one value applies to every file, so all
# fourteen stacks collapse into a single project, and the portal's own grouping
# (a system IS a compose project) reports one enormous system. The thing under
# test would be a different thing.
set -uo pipefail

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"

# ASSERT WE FOUND THE REPO BEFORE TARRING ANYTHING. The path above is derived
# from this file's own location, which is right while the file lives in scripts/
# and catastrophically wrong the moment a copy of it does not: run it from /tmp
# and `$(dirname)/..` is `/`, so the tar below streams the entire filesystem into
# a container. That is not a hypothetical - it is what happened the first time
# this script was tested, from a copy in /tmp, and it ran for three minutes
# before anyone looked. Three files it cannot be wrong about:
for marker in justfile .env.example scripts/bootstrap.sh; do
  [ -e "$REPO/$marker" ] || die "this does not look like the Bothy repo ($REPO has no $marker)"
done
DIND=bothy-ci-dind
IMAGE=docker:28-dind


# ── an isolated daemon ───────────────────────────────────────────────────────
#
# THERE IS NO "RUN IT AGAINST THIS DAEMON" OPTION, and that is the design. The
# first draft had a --here flag with a guard that refused when Bothy containers
# were already running. It was both a footgun and broken - the rest of the script
# execs into the dind container, which --here does not create - and the guard was
# the wrong shape anyway: "no Bothy running right now" does not make it safe to
# create fourteen globally-named projects on a daemon somebody else is using.
command -v docker >/dev/null 2>&1 || die "docker is not installed"

echo "== an isolated daemon =="
docker rm -f "$DIND" >/dev/null 2>&1
# --privileged is what dind requires. It is why this is a deliberate command and
# not something `just verify` runs.
docker run -d --privileged --name "$DIND" \
  -e DOCKER_TLS_CERTDIR= \
  "$IMAGE" --host=tcp://0.0.0.0:2375 >/dev/null \
  || die "could not start $IMAGE"
# DELIBERATELY NOT removed on exit. This is a debugging tool: on failure the
# container holds the only copy of the broken stack, and on success it is the
# thing you run the suites against. An auto-remove would make it a script that
# tells you it failed and then destroys the evidence. It is removed at the START
# of the next run instead, and the command to do it by hand is printed at the end.

say "waiting for the inner daemon"
for _ in $(seq 1 60); do
  docker exec "$DIND" docker info >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$DIND" docker info >/dev/null 2>&1 || die "the inner daemon never came up"
ok "inner daemon ready ($(docker exec "$DIND" docker --version))"

# ── the install ──────────────────────────────────────────────────────────────
echo
echo "== the install =="

# TRACKED FILES ONLY, taken from the working tree - `git ls-files`, not a plain
# tar and not `git archive`.
#
#   a plain tar    copies GITIGNORED files too, and that quietly breaks the
#                  thing this script is for. The first run reported
#                  "already present  monitoring/prom-password.txt" on what was
#                  supposed to be a fresh install: the file had come from this
#                  box. Every generated file would have been pre-supplied, so
#                  the run could not have caught bootstrap failing to create
#                  one - the exact class of bug bootstrap exists to fix.
#   git archive    uses HEAD, so uncommitted edits are not tested. Running this
#                  BEFORE pushing is the entire point.
#
# `ls-files` names what is tracked; the bytes come off disk. So: a clone's file
# set, with your working changes in it.
# UNTRACKED FILES ARE NOT COPIED, so say so before spending fifteen minutes
# finding out. A new script that has not been `git add`ed is invisible to
# `ls-files`, and the run fails inside the container with a "No such file or
# directory" for a file that is plainly sitting in front of you. That is exactly
# how this run failed the first time scripts/lib/secret-keys.sh was written.
untracked=$(git -C "$REPO" ls-files --others --exclude-standard)
if [ -n "$untracked" ]; then
  printf '  \033[33m!\033[0m %s\n' "these files are untracked and will NOT be copied in:"
  printf '      %s\n' $untracked
  say "  \`git add\` them first if the install needs them."
fi

docker exec "$DIND" sh -c 'rm -rf /bothy && mkdir -p /bothy' 2>/dev/null \
  || die "could not prepare /bothy in the container"
git -C "$REPO" ls-files -z \
  | tar -C "$REPO" --null -T - -cf - \
  | docker exec -i "$DIND" tar -C /bothy -xf - \
  || die "could not copy the tree in"
# .git as well: files-check ends in `git reset --hard` and the git-ops checks
# need a real repository. Shallow, because history is not under test.
git -C "$REPO" bundle create /tmp/bothy-ci.bundle HEAD >/dev/null 2>&1 \
  && docker exec -i "$DIND" sh -c 'cat > /tmp/b.bundle' < /tmp/bothy-ci.bundle \
  && docker exec "$DIND" sh -c 'cd /bothy && git init -q . && git remote add o /tmp/b.bundle && git fetch -q o >/dev/null 2>&1 && git reset -q --mixed FETCH_HEAD' 2>/dev/null
rm -f /tmp/bothy-ci.bundle
ok "tracked files copied in ($(git -C "$REPO" ls-files | wc -l) files, working-tree state)"

# The inner daemon's bridge gateway, for the same reason the CI job needs it:
# auth/compose.yml builds Keycloak's issuer from BOX_IP, and oauth2-proxy
# fetches that discovery document from inside its own container.
GW=$(docker exec "$DIND" docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null)
[ -n "$GW" ] || die "no bridge gateway inside the container"
ok "inner bridge gateway: $GW"

echo
say "Everything below runs INSIDE $DIND. Nothing touches this box's daemon."
say "To watch it:   docker exec -it $DIND sh"
echo

docker exec -i -e BOTHY_BASE_HOST="$GW" "$DIND" sh -c '
  set -e
  # py3-requests: the suites named at the end of this script need it (the
  # authenticated probes in the editor tier import it). Installed here rather
  # than leaving that advice to fail on its first line.
  #
  # NO APOSTROPHES IN THIS BLOCK. It is the body of sh -c '...', so one
  # apostrophe closes the quote and the script stops parsing - which is exactly
  # how this comment broke it the first time it was written.
  apk add --no-cache bash git curl jq python3 py3-requests openssl just nodejs npm >/dev/null 2>&1 \
    || { echo "could not install the prerequisites in the container"; exit 1; }
  cd /bothy
  cp .env.example .env
  just up
'
rc=$?

echo
if [ "$rc" = 0 ]; then
  ok "the stack came up inside the isolated daemon"
  say "Run the suites with:"
  say "  docker exec -it $DIND sh -c 'cd /bothy && just verify'"
  say "  docker exec -it $DIND sh -c 'cd /bothy && just files-check'"
else
  printf '  \033[31m✗\033[0m %s\n' "the install failed inside the container (exit $rc)"
  say "The container is LEFT RUNNING so you can look:"
  say "  docker exec -it $DIND sh -c 'cd /bothy && docker ps -a'"
  say "  docker logs $DIND"
fi

echo
say "When you are done:  docker rm -f $DIND"
exit $rc
