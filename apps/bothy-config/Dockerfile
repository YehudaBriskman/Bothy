# Alpine + python3 + one pinned dependency.
#
# There is a pip install step here and there is none in apps/portal-files -
# that difference is the whole reason these are two services rather than one
# endpoint. See requirements.txt.
FROM python:3.13-alpine

WORKDIR /app

# Dependencies before source, so editing app.py does not re-resolve the pin.
COPY requirements.txt ./
# --no-cache-dir keeps the wheel cache out of the image; --only-binary=:all:
# means a source distribution is a BUILD FAILURE rather than a silent compile
# from tarball. This image has no compiler, so a sdist would fail anyway - it
# fails here with a readable message instead of a page of gcc output.
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt

COPY safepath.py yamlpatch.py app.py policy.toml ./

# No git in this image, unlike portal-files. This service does not commit; a
# patch is a file write and the repository's history is made with `git` in a
# terminal. Installing it "in case" would put a binary that can rewrite history
# in a container holding a writable mount on the stack repo.

# Runs as a NON-ROOT user whose uid matches the host's devssh (1000), because the
# root is bind-mounted from the host and the files it rewrites must stay owned by
# the human who owns the repo. Running as root would leave root-owned files in
# ~/stacks that then need sudo to edit by hand - the classic bind-mount
# ownership trap.
RUN adduser -D -u 1000 app
USER app

ENV PORT=8098
EXPOSE 8098

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8098/healthz',timeout=2).status==200 else 1)"

CMD ["python3", "-u", "app.py"]
