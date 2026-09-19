# bothy-ops: Alpine + python3, and nothing else.
#
# BUILT FROM apps/ (compose: `context: ..`), so bothy_common can be copied in.
# apps/.dockerignore is an allowlist; a file not named there is not in the
# context, so a new module must be added to it as well as to a COPY below.
#
# No pip step. This process holds a path to the Docker daemon and a cluster
# token, and every dependency is something that can ship a vulnerability into
# that position. http.client against a socket proxy and against the apiserver is
# the whole client.
#
# No docker CLI and no kubectl, and the omissions are the design. This container
# has no socket and a token that cannot exec; installing a binary that speaks the
# whole API would leave the next person one wiring change away from using it.
FROM python:3.13-alpine@sha256:7415fbc3c9e4979cc717d92377ab2bc7b2b4a2af1ac03cc52b5f3f88efedaf3a

WORKDIR /app

COPY bothy-common/bothy_common ./bothy_common
COPY bothy-ops/guard.py bothy-ops/control.py bothy-ops/kube.py bothy-ops/admin.py bothy-ops/app.py bothy-ops/catalog.toml ./

# The Jobs run-template may create, from the `jobtemplates` build context
# (compose.yml: additional_contexts -> ../../k8s/job-templates). BAKED IN, not
# mounted: a template is part of what was reviewed and built, and a request can
# only NAME one. kube.load() refuses to start if a catalog template is missing.
# A bare `docker build` needs: --build-context jobtemplates=k8s/job-templates
COPY --from=jobtemplates thales-dev/*.yaml ./job-templates/thales-dev/
COPY --from=jobtemplates thales-pre-prod/*.yaml ./job-templates/thales-pre-prod/

# Non-root, never able to become root (compose adds no-new-privileges and drops
# every capability). uid 1000 so the audit log and the 600-mode token files are
# owned by the human who owns the checkout.
RUN adduser -D -u 1000 app
USER app

ENV PORT=8097
EXPOSE 8097

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8097/healthz',timeout=2).status==200 else 1)"

CMD ["python3", "-u", "app.py"]

# The commit this image was built from (`just up-apps` passes the HEAD sha).
# LAST, so a new commit changes one metadata layer and every layer above comes
# from cache. The upgrade workflow compares it to HEAD with `docker inspect`: it
# is how CI proves an upgrade actually rebuilt this image.
ARG REVISION=unknown
LABEL org.opencontainers.image.revision=$REVISION
