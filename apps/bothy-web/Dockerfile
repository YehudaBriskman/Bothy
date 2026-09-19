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
FROM node:26.9.0-alpine@sha256:dbaa92e5758cbbcf85d65d5403fdb530fe3442cbe8c6dbfb7ef23365450d5070 AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
# apps/bothy-web/.dockerignore keeps web/node_modules and web/dist out of the
# context - without it this COPY would lay the HOST's node_modules over the one
# `npm ci` just installed, and the lock file would stop meaning anything.
COPY web/ ./
RUN npm run build

FROM nginx:1.31-alpine@sha256:62ff2089abf5a9ed33bd232895bef5e22f7bb4b200675cec49a5ebc48e3d4ac8
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
RUN printf '{"revision":"%s"}\n' "$REVISION" > /usr/share/nginx/html/version.json
