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
| `dnsmasq/dev.conf` | `/etc/dnsmasq.d/dev.conf` | Wildcard `*.test` → this box's tailnet IP. Tailscale split DNS routes `test` here, which is what makes every `<name>.dev.test` resolve across the tailnet. |
| `docker/daemon.json` | `/etc/docker/daemon.json` | Log rotation (10m × 3) and `metrics-addr` on :9323, which `monitoring/prometheus.yml` scrapes as its `docker-daemon` job. Without it that target is permanently down. |
| `wsl/wsl.conf` | `/etc/wsl.conf` (in the distro) | `systemd=true` — the reason `docker.service` can be enabled and every stack comes up with the distro. Also `generateResolvConf=false`. |
| `wsl/wslconfig` | `C:\Users\devssh\.wslconfig` | Memory, CPU and nested virtualisation for the WSL VM. |
| `wsl/resolv.conf` | `/etc/resolv.conf` | Points the box at its own dnsmasq. Held with `chattr +i` — see below. |
| `systemd/stacks-backup.*` | `/etc/systemd/system/` | The nightly backup timer at 03:00. |
| `systemd/minikube.service` | `/etc/systemd/system/` | Starts minikube with the distro. |
| `windows/DevBox-WSL-Keepalive.xml` | Windows Task Scheduler | **The most important file here.** See below. |

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
