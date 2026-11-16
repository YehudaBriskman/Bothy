# Multi-stage: node builds the Vite app, nginx serves the static dist/.
#
# REPRODUCIBLE, on purpose (2026-09-18, updates plan step 0):
#   - both bases are pinned as `tag@sha256:digest`. The tag is for the reader and
#     for Dependabot (the `docker` entry for /apps/bothy-web bumps both halves
#     together); the digest is what docker actually pulls. They were the bare
#     floating `node:26-alpine` and `nginx:alpine`, so two builds of one commit
#     could ship different nginx builds and nobody could say which was running.
#   - `npm ci`, not `npm install`: it installs exactly package-lock.json and
#     FAILS if the lock and package.json disagree, where `install` silently
#     re-resolved and could rewrite the lock inside the image.
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
# apps/bothy-web/.dockerignore keeps web/node_modules and web/dist out of the
# context - without it this COPY would lay the HOST's node_modules over the one
# `npm ci` just installed, and the lock file would stop meaning anything.
COPY web/ ./
RUN npm run build

# ── runs as uid 101, not root (#336) ──────────────────────────────────────────
#
# The base is nginxinc/nginx-unprivileged - the nginx project's own variant of
# the stock image: same nginx build and Alpine, USER 101 (nginx), pid file and
# temp paths under /tmp, and `listen 8080` (nginx.conf here too). The stock
# `nginx` image has a root master process. Chosen over keeping it and adding
# `USER nginx` because that route means redoing the variant's work by hand (pid
# file, /var/cache/nginx, the entrypoint scripts that write /etc/nginx as root)
# and keeping it right on every nginx bump.
#
# The digest is the multi-arch INDEX for the 1.31-alpine tag, the same style as
# the two pins above; Dependabot's `docker` entry for /apps/bothy-web bumps it
# with the tag. What does NOT change: the host port (Traefik still owns :80 and
# reaches this at the service port in compose.yml), every byte nginx serves, and
# the ./data bind mount - the stock image's WORKERS were already uid 101 reading
# it, so nothing on the host needs a chmod.
FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# ── which commit this image was built from ────────────────────────────────────
#
# `just up-apps` passes REVISION=$(git rev-parse HEAD) (compose.yml build.args).
# It lands in two places:
#   - the OCI label, for `docker inspect` - the same label bothy-files and
#     bothy-ops carry, so one command answers "is the running code HEAD?";
#   - /version.json, for a BROWSER, which cannot docker-inspect. An open tab that
#     sees it change knows Bothy was updated under it (docs/plans/updates.md §6).
#     nginx.conf serves it with an exact location, no-cache, and a real 404 -
#     never the SPA fallback.
#
# LAST, and only here: the ARG invalidates the layers after it, so a new commit
# re-runs this one tiny RUN and nothing else. The bundle above is built from the
# sources alone, so a commit that does not touch web/ reuses it from cache.
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=$REVISION
# The html dir is root-owned and this image's default user is not, so the one
# write that needs root happens here and the process never gets it back.
USER root
RUN printf '{"revision":"%s"}\n' "$REVISION" > /usr/share/nginx/html/version.json
USER 101
