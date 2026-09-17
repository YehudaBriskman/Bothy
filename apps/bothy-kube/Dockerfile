# Alpine + python3, and nothing else - the same base as bothy-control, on the
# same reasoning: no pip step, because there is no dependency to argue about.
#
# NO kubectl in this image, and that is the design rather than an economy.
# kubectl speaks the whole Kubernetes API, exec and port-forward included. The
# token mounted here cannot do either (k8s/rbac/bothy-kube.yaml), and installing
# the binary would leave the next person one Role edit away from a browser shell
# with the tool already in place.
FROM python:3.13-alpine

WORKDIR /app

COPY guard.py app.py catalog.toml ./

# Non-root, and never able to become root (compose adds no-new-privileges and
# drops every capability). uid 1000 so the audit log and the 600-mode token
# files are owned by the human who owns the repo.
RUN adduser -D -u 1000 app
USER app

ENV PORT=8098
EXPOSE 8098

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8098/healthz',timeout=2).status==200 else 1)"

CMD ["python3", "-u", "app.py"]
