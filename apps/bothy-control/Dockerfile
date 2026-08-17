# Alpine + python3, and nothing else.
#
# There is no pip install step here, unlike apps/bothy-config. That service
# carries a YAML round-tripper and argues for it; this one has no dependency to
# argue about, on portal-files' reasoning: every dependency is something that
# can ship a vulnerability into a process whose one capability is acting on
# containers. Talking to a socket proxy is http.client against a plain HTTP
# port, which the standard library has done since forever.
FROM python:3.13-alpine

WORKDIR /app

COPY guard.py app.py ./

# No docker CLI in this image, and the omission is the design rather than an
# economy. This container has no docker socket mounted at all - it reaches the
# daemon only through two proxies that between them permit inspect, stop,
# restart, kill and start. Installing `docker` here would put a binary that
# speaks the whole API in a container that is deliberately unable to use it, and
# the next person would wire it up.
#
# Runs as a NON-ROOT user. There is no bind-mount ownership argument here the
# way there is in the editor tier - the only mount is the audit log - but uid
# 1000 keeps that log owned by the human who owns the repo, and root in a
# container that can stop containers is a combination with no upside.
RUN adduser -D -u 1000 app
USER app

ENV PORT=8097
EXPOSE 8097

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8097/healthz',timeout=2).status==200 else 1)"

CMD ["python3", "-u", "app.py"]
