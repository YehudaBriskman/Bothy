# shellcheck shell=bash
# Everything `bootstrap` may write into .env, in the one place both callers read.
#
#   scripts/bootstrap.sh   writes these when they are blank or a placeholder
#   justfile `up`          unsets them before re-invoking just, so compose reads
#                          what bootstrap just WROTE rather than what was on disk
#                          when just parsed the file
#
# WHY THE UNSET IS NEEDED AT ALL. `set dotenv-load` reads .env when just PARSES
# the justfile - before any recipe runs, so before bootstrap has written
# anything. just then does not override a variable already in the environment,
# which means the child process keeps the parent's stale copy.
#
# AN EMPTY VALUE IS NOT EXPORTED, and that is what made this so easy to get half
# right. OAUTH2_COOKIE_SECRET ships blank, so it was simply absent from the
# environment and the child read the generated one correctly. Every key that
# ships with a PLACEHOLDER - a non-empty value - was exported, kept, and used:
#
#   POSTGRES_PASSWORD   Postgres would initialise with `changeme-generate-one`
#                       while .env held a real password, and the next `just up`
#                       could not connect to the database it had just created.
#   BOX_IP              oauth2-proxy dialled 100.64.0.1:8090 for OIDC discovery,
#                       timed out, crash-looped, and every gated route answered
#                       502 - on a stack whose .env plainly said 172.18.0.1.
#                       Observed, in that form, by `just ci-install`.
#
# So the list is not "the secrets", it is "anything bootstrap may rewrite". If
# the two callers ever disagree, the failure is silent and looks like a network
# problem.
#
# ONE KEY PER LINE. On a single line this is `SECRET_KEYS="POSTGRES_PASSWORD ...`,
# which is the shape of a leaked credential - a name ending in SECRET, an `=`,
# and a long unbroken run - and it trips this repo's own scanner
# (`just files-check`) as "contains what looks like a live credential". Word
# splitting treats a newline exactly like a space, so the shape costs nothing to
# remove and a public repository should not ship a line that reads as a secret to
# every tool that looks.
# Both are consumed by OTHER files - bootstrap sources this, and the justfile
# reads it in a subshell - so the linter cannot see the use and would call them
# dead. That is what the directive is for; it is not hiding anything.
# shellcheck disable=SC2034

# The five credentials. bootstrap GENERATES these; nothing else does.
SECRET_KEYS="
POSTGRES_PASSWORD
DEV_LOGIN_PASSWORD
OAUTH2_COOKIE_SECRET
KEYCLOAK_DB_PASSWORD
KEYCLOAK_OAUTH2_CLIENT_SECRET
"

# Everything the justfile must unset before re-invoking just: the generated
# credentials, plus the values bootstrap DERIVES rather than generates. BOX_IP is
# resolved from box-addr.sh, PUID/PGID from `id`, and all three ship non-empty or
# are written on a first run - so all three are exported stale by the parent.
BOOTSTRAP_KEYS="$SECRET_KEYS
BOX_IP
PUID
PGID
"
