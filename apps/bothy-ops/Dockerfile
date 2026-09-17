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
FROM python:3.13-alpine

WORKDIR /app

COPY bothy-common/bothy_common ./bothy_common
COPY bothy-ops/guard.py bothy-ops/control.py bothy-ops/kube.py bothy-ops/app.py bothy-ops/catalog.toml ./

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
