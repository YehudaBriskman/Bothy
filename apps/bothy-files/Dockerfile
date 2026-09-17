# bothy-files: Alpine + python3 + git + ONE pinned dependency.
#
# BUILT FROM apps/ (compose: `context: ..`), so bothy_common can be copied in.
# apps/.dockerignore is an allowlist; a file not named there is not in the
# context, so a new module must be added to it as well as to a COPY below.
FROM python:3.13-alpine

# git is how /history, /repos, /status and /git/diff read the repositories. This
# service changes no repository's history or index; see app.py's header.
RUN apk add --no-cache git

WORKDIR /app

# Dependencies before source, so editing app.py does not re-resolve the pin.
#
# ruamel.yaml, for the config forms only (config_api.py -> yamlpatch.py). It is
# the ONE third-party package in a process holding read-write mounts on two git
# repositories, and that is a deliberate relaxation recorded in SECURITY.md -
# see requirements.txt for why it is pinned exactly.
#
# --only-binary=:all: makes a source distribution a BUILD FAILURE rather than a
# silent compile from tarball; this image has no compiler anyway.
COPY bothy-files/requirements.txt ./
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt

COPY bothy-common/bothy_common ./bothy_common
COPY bothy-files/app.py bothy-files/config_api.py bothy-files/yamlpatch.py bothy-files/policy.toml ./

# A NON-ROOT user whose uid matches the host owner of the bind-mounted repos, so
# the files it writes stay owned by the human who owns them (compose overrides
# the uid with PUID/PGID). Root would leave root-owned files in ~/stacks.
RUN adduser -D -u 1000 app
USER app

ENV PORT=8099
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8099/healthz',timeout=2).status==200 else 1)"

CMD ["python3", "-u", "app.py"]
