# VM proof of the uid-101 web image and today's image bumps

Run on 2026-11-16 in the lab VM `lab-mid` (`lab/lab.sh`; 2 vCPU, 4 GiB, Ubuntu 24.04 guest,
kernel 6.8.0-147, Docker 29.1.3 from `docker.io`). The guest cloned the public repo at
`b19d273` (main, which contains #344, #347 and #348). Nothing from the host's Docker,
`~/stacks` services or env files entered the VM. `lab.sh down lab-mid` was run at the end.

What was under test: #344 (`nginxinc/nginx-unprivileged`, uid 101, `listen 8080`,
`own_web_port` 80 to 8080, compose port and healthcheck), #348 (node 26.13.1 build stage of
bothy-web) and #347 (python 3.15 digest in bothy-files and bothy-ops).

## Verdicts

| # | Item | Verdict |
|---|---|---|
| 1 | Docker and clone in the guest | PASS |
| 2 | bothy-web: uid 101, :8080 only, bytes, headers, restart, logs | PASS |
| 2b | read-only rootfs | PASS only with a tmpfs on /tmp (compose does not declare read_only) |
| 3 | bothy-files and bothy-ops images build, start, answer `/healthz` | PASS |
| 4 | updater unit checks (`run.sh --offline`) | PASS (2718 PASS lines, no FAIL result) |
| 4b | `e2e_owncode.py` on throwaway projects, as CI runs it | PASS on the 4th run; see the two failed runs |
| 5 | negative tests | PASS (the checks can fail) |
| 6 | VM stopped | PASS |

## 2. bothy-web, built and run as compose declares

Build: `docker build --build-arg REVISION=<sha> -t bothy-web:vmproof .` (legacy builder, rc 0,
image 94.8 MB). Run: the repo's own `apps/bothy-web/compose.yml` via `docker compose up -d
--no-build` with a pre-created `devnet` network (compose declares: memory 64m, `./data:ro`
bind, healthcheck on 127.0.0.1:8080, no `user`, no `read_only`, no `cap_drop`).

```
bothy-web Up 8 seconds (healthy) 8080/tcp
docker exec bothy-web id            -> uid=101(nginx) gid=101(nginx) groups=101(nginx)
/proc/1/status                      -> Uid: 101 101 101 101   CapEff: 0000000000000000
processes: 1 uid=101 nginx: master process; 21,22 uid=101 nginx: worker process
inspect: User=101 ReadonlyRootfs=false CapDrop=[] Health=healthy Mem=67108864
ss -ltnp: tcp 0.0.0.0:8080 LISTEN 1/nginx: master pro      (no :80 listener)
wget 127.0.0.1:80 rc=1 (Connection refused);  wget 127.0.0.1:8080 rc=0
```

Bytes (not status codes). The reference is `/app/dist` of the `--target build` stage:

```
build output index.html   3aa71460a52e0888fc19cf4859cfe342103826ad1ce60bda3494e0cd75a3c3a8
served GET /              3aa71460a52e0888fc19cf4859cfe342103826ad1ce60bda3494e0cd75a3c3a8
served GET /no/such/route 3aa71460...3c3a8   (SPA fallback: same bytes as index.html, 200)
asset CodeSurface-BfobabQ2.js  build 6e6e9790...0924873 == served == gunzip(served, Accept-Encoding gzip)
/version.json   {"revision":"b19d27351b99a8a983e2a2cf51d723b78b6bba07"}  (equals the build arg)
/data/themes/nope.css -> 404 (no fallback, as nginx.conf declares); /data/themes/ -> JSON autoindex
```

Headers as nginx.conf declares them: `/` has `Cache-Control: no-cache`, a `Content-Security-Policy`
(script hash, `connect-src 'self'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, `Permissions-Policy: camera=(), microphone=()...`. `/assets/*` has `public,
max-age=31536000, immutable` plus nosniff. `/version.json` and `/data/themes/` have `no-cache` plus nosniff.

Restart: `docker restart bothy-web` came back `healthy`, uid 101, same index.html sha256.

Logs: no `emerg`, `permission` or `denied` lines. The only match of a broad grep is the
stock entrypoint's `10-listen-on-ipv6-by-default.sh: info: can not modify
/etc/nginx/conf.d/default.conf (read-only file system?)`. It is an info line (the script cannot
edit the file as uid 101, and nginx.conf does not listen on 80, so nothing is lost). It will
appear in every start; do not mistake it for a fault.

The host's `./data` bind: directories were `drwxr-xr-x` (live repo: same), readable by
uid 101; a write inside the `:ro` mount fails with `Read-only file system`.

### 2b. Read-only rootfs (stricter than compose)

`--read-only --tmpfs /tmp --cap-drop ALL --no-new-privileges`: uid 101, same index sha256,
no error lines. Without the tmpfs: `[emerg] mkdir() "/tmp/proxy_temp" failed (30: Read-only
file system)`, container exits 1. So `read_only: true` is possible later, but only with `tmpfs: [/tmp]`.

## 3. bothy-files and bothy-ops

Built from `apps/` as compose does (ops needs `--build-context jobtemplates=../k8s/job-templates`,
so `docker-buildx` was installed; the legacy builder rejects that flag). Both run with
what their compose files declare (`user 1000`, `read_only`, `tmpfs /tmp`, `no-new-privileges`, ops
also `cap_drop ALL`):

```
bothy-ops   Up (healthy)  GET /healthz -> HTTP 200 {"ok": true, "verbs": [...], ...}  uid 1000  Python 3.15.2
bothy-files Up (healthy)  GET /healthz -> HTTP 200 {"ok": true, "roots": ["home","notes","projects","stacks"],...}  uid 1000  Python 3.15.2
both: org.opencontainers.image.revision = b19d27351b99...
```

bothy-files first exited with `PolicyError: root 'stacks' points at /repos/stacks, which is not a
directory`. That is its design (the roots must be mounted); it started once the four roots were mounted
(read-only, on throwaway dirs).

## 4. Updater checks

`bash apps/bothy-ops/checks/run.sh --offline` in the guest: rc 0, `all checks passed`
(2718 lines beginning `  PASS`; the 7 lines containing the word FAIL are PASS lines about recorded failures).

`e2e_owncode.py` needs docker, `just` and a systemd user manager only, and drives throwaway repos and a
project named `bothy-owncode-test` with no host ports; CI runs it as `run.sh --e2e=own-code-and-majors`,
which also runs `e2e_pgmajor.py`. In the VM only `e2e_owncode.py` was run (`just` 1.21.0 from apt),
four times:

| Run | Result | Cause |
|---|---|---|
| 1 | FAIL in 2b (timer), then crash in stage 3 | the guest's systemd **user manager** had started before `lab` was added to group `docker`, so the rollback timer's `docker` call got `permission denied ... docker.sock`. A lab setup fault, fixed with `systemctl restart user@1000` |
| 2 | same as 1 | same |
| 3 | 2b passes; stage 3 `verify outlived the rollback timer` (a 8 s test timer fired during verify) | timing on a 2-vCPU nested VM; not reproduced |
| 4 | `e2e_owncode: all passed`, 27 PASS, 0 FAIL, no SKIP | clean state |

Not run: `e2e_pgmajor.py`, `e2e_updater.py`, `e2e_config.py`, `e2e_auto.py`, `e2e_cluster.py`
(unrelated to #344, and cluster needs minikube).

The e2e fixture uses its own stock nginx on :80 (as #344 says), so it proves the updater's
mechanics but does NOT exercise the real bothy-web image or the real `own_web_port=8080` probe against it.
That gap is closed by hand below.

## 5. Negative tests

1. The old config as uid 101 where the privileged-port floor is not lowered
   (`--sysctl net.ipv4.ip_unprivileged_port_start=1024`, the Kubernetes/rootless model):
   `[emerg] bind() to 0.0.0.0:80 failed (13: Permission denied)`, exit 1. The same sysctl with the
   new config: serves index.html (sha256 3aa71460...). Docker's default floor lets `listen 80` work
   as uid 101, so the old-port failure is a portability one, not a Docker one (confirmed: with the
   old config on default Docker the container stays up).
2. The pre-#344 image (`nginx:1.31-alpine@sha256:713fc2eb...`): master `uid=0`, workers uid 101. The
   new image has no root process.
3. The old updater probe port: `wget 127.0.0.1:80` inside the new container is refused (rc 1).
   That is the deploy-order hazard in the #344 commit message, now observed rather than argued:
   an installed updater that still probes :80 would see verify fail and roll back.

## Not verified

- The live Traefik routing to `:8080` (no Traefik in the VM); the catch-all keeps working only if
  the label `server.port=8080` is picked up, which `docker inspect` of compose labels shows but no router table did.
- The updater's own `own_web_port` probe code path against the real new image (the e2e fixture uses stock nginx on 80).
- The live host: bind-mount ownership there (checked only that the repo dir is `rwxr-xr-x`), the installed
  updater copy's version, the arm64 variant of the image (the pinned digest is a multi-arch index;
  only amd64 ran).
- Run-3's stage-3 failure was not root-caused beyond timing; one clean run followed.
- The lab guest can reach the host via 10.0.2.2 (lab/README known gap); no untrusted code was run.
- Leftover containers `nets`, `pub9`, `dc` from the earlier spike were present in the guest disk and left alone.
- Used the legacy `docker build` for bothy-web (no BuildKit); the live box builds with compose and may use BuildKit.
