# Alpine + python3 + git, and nothing else. There is no pip install step because
# app.py imports only the standard library - see its module docstring for why
# that was a deliberate choice for the first write-capable service on this box.
FROM python:3.13-alpine

# git is the version store; the app shells out to it for log/add/commit.
RUN apk add --no-cache git

WORKDIR /app
COPY safepath.py app.py policy.toml ./

# Runs as a NON-ROOT user whose uid matches the host's devssh (1000), because the
# roots are bind-mounted from the host and the files it commits must stay owned
# by the human who owns the repos. Running as root would leave root-owned files
# in ~/stacks that then need sudo to edit by hand - the classic bind-mount
# ownership trap.
RUN adduser -D -u 1000 app
USER app

# Both repos are bind-mounted here by compose. git refuses to operate on a repo
# owned by a different uid unless it is marked safe; uid 1000 matching the host
# owner is what makes that unnecessary.
ENV PORT=8099
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8099/healthz',timeout=2).status==200 else 1)"

CMD ["python3", "-u", "app.py"]
