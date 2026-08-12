# host/ — the configuration that is not in a container

Everything else in this repository describes containers. None of it is any use on
a fresh machine without the host-level configuration below, which lives in `/etc`,
in the Windows registry, and in Task Scheduler — none of which git sees.

**These are copies, not the live files.** Nothing reads them at runtime. They exist
so the box can be rebuilt, and so a change to host state leaves a diff behind
instead of vanishing. After editing a real file, copy it back here.

## What each file is, and why it matters

| Copy | Real location | Why it exists |
|---|---|---|
| `dnsmasq/dev.conf` | `/etc/dnsmasq.d/dev.conf` | Wildcard `*.test` → this box's tailnet IP. **Superseded 2026-08-12**: the name layer was DELETED, not parked — zero `Host()` rules remain in Traefik's router table, and access is pure IP:port. Restoring names is a rebuild (re-add the split-DNS route *and* re-declare a router per service), not a switch. dnsmasq itself still runs as the box's own resolver, which is why this file stays. |
| `docker/daemon.json` | `/etc/docker/daemon.json` | Log rotation (10m × 3) and `metrics-addr` on :9323, which `monitoring/prometheus.yml` scrapes as its `docker-daemon` job. Without it that target is permanently down. |
| `wsl/wsl.conf` | `/etc/wsl.conf` (in the distro) | `systemd=true` — the reason `docker.service` can be enabled and every stack comes up with the distro. Also `generateResolvConf=false`. |
| `wsl/wslconfig` | `C:\Users\devssh\.wslconfig` | Memory, CPU and nested virtualisation for the WSL VM. |
| `wsl/resolv.conf` | `/etc/resolv.conf` | Points the box at its own dnsmasq. Held with `chattr +i` — see below. |
| `systemd/stacks-backup.*` | `/etc/systemd/system/` | The nightly backup timer at 03:00. |
| `systemd/minikube.service` | `/etc/systemd/system/` | Started minikube with the distro. **Disabled 2026-08-12** — installed but no longer enabled, so minikube is stopped by default. See below. |
| `windows/DevBox-WSL-Keepalive.xml` | Windows Task Scheduler | **The most important file here.** See below. |

## minikube is stopped by default (since 2026-08-12)

`minikube.service` is still installed, but it is **disabled** — minikube no
longer starts with the distro, and `just up` never touched it either way.

It was retired because it was measured doing nothing: `kubectl get pods -A`
showed only `kube-system`, the only Service in the cluster was the default
`kubernetes` ClusterIP, and nothing had ever been deployed to it — yet it had
been up 27 days holding **1,046 MB**, the largest single consumer of the box's
4,678 MB of container memory.

The cluster was **stopped, not deleted**. `minikube profile list` still shows
the `minikube` profile (docker driver, v1.35.1) in state `Stopped`, so its state
is intact and starting it returns the same cluster.

    minikube start                          # bring it back for one session
    sudo systemctl enable --now minikube    # start-with-the-distro again

Never `minikube delete` to "clean up" — stopping is reversible, deleting is not.

## The keepalive task

WSL2 destroys the VM 60 seconds after the last Windows-side client disconnects.
An SSH session counts as such a client, which is why this box appeared to work
only while somebody was connected and died shortly after they left — taking
docker, every container, and the Tailscale node with it.

The task holds `wsl -u root -e sleep infinity` open forever. It runs as `devssh`
with a stored password so it fires at boot with nobody logged in, and its
execution time limit is disabled so Task Scheduler does not kill it after the
default three days.

    schtasks /create /TN "DevBox-WSL-Keepalive" /XML host\windows\DevBox-WSL-Keepalive.xml /RU devssh /RP *

Nothing in this repository can substitute for it: `restart: unless-stopped` is
inert if the docker daemon never starts, and the daemon lives inside the distro
this task keeps alive.

## resolv.conf is immutable on purpose

WSL rewrites `/etc/resolv.conf` whenever Windows' DNS configuration changes —
connecting the Windows Tailscale client is enough to trigger it — and
`generateResolvConf=false` only takes effect at the next boot. A running distro
therefore needs `chattr +i` to hold the file. It is also a real file rather than
the `resolvconf` symlink into tmpfs, because the immutable bit cannot be set on
tmpfs.

    sudo chattr -i /etc/resolv.conf   # to edit
    sudo chattr +i /etc/resolv.conf   # when done

Pointing at dnsmasq is not only about `.test` resolving locally. dnsmasq answers
AAAA for `.test` with an immediate NODATA, while the upstream Windows resolver
never replies at all. That difference is what makes a plain `curl http://x.test`
hang until timeout while `curl -4 http://x.test` succeeds instantly.

## Traefik's dynamic mount goes stale on `git checkout`

Not a file, but it belongs with the other traps. A bind mount pins the host inode
at container-creation time, and `git checkout` deletes and recreates directories
rather than editing them in place. After any branch switch Traefik keeps reading
an orphaned, empty copy of `edge/dynamic` and silently serves its last in-memory
config — so `--providers.file.watch=true` stops meaning anything.

    docker compose -f edge/compose.yml up -d --force-recreate
