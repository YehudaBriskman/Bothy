# host/ - the configuration that is not in a container

Everything else in this repository describes containers. None of it is any use on
a fresh machine without the host-level configuration below, which lives in `/etc`,
in the Windows registry, and in Task Scheduler - none of which git sees.

**These are copies, not the live files.** Nothing reads them at runtime. They exist
so the box can be rebuilt, and so a change to host state leaves a diff behind
instead of vanishing. After editing a real file, copy it back here.

## What each file is, and why it matters

| Copy | Real location | Why it exists |
|---|---|---|
| `dnsmasq/dev.conf` | `/etc/dnsmasq.d/dev.conf` | Wildcard the name layer → this box's tailnet IP. **The name layer was DELETED on 2026-08-12, not parked** - zero `Host()` rules remain in Traefik's router table and access is pure IP:port, so restoring names is a rebuild, not a switch. **dnsmasq itself still runs and still matters** as the box's own resolver: `domain-needed` is what keeps bare dotless hostnames from hanging. See below. |
| `docker/daemon.json` | `/etc/docker/daemon.json` | Log rotation (10m × 3) and `metrics-addr` on :9323, which `monitoring/prometheus.yml` scrapes as its `docker-daemon` job. Without it that target is permanently down. |
| `wsl/wsl.conf` | `/etc/wsl.conf` (in the distro) | `systemd=true` - the reason `docker.service` can be enabled and every stack comes up with the distro. Also `generateResolvConf=false`. |
| `wsl/wslconfig` | `C:\Users\devssh\.wslconfig` | Memory, CPU and nested virtualisation for the WSL VM. |
| `wsl/resolv.conf` | `/etc/resolv.conf` | Points the box at its own dnsmasq. Held with `chattr +i` - see below. |
| `systemd/stacks-backup.*` | `/etc/systemd/system/` | The nightly backup timer at 03:00. |
| `systemd/minikube.service` | `/etc/systemd/system/` | Started minikube with the distro. **Stopped and disabled 2026-08-12** - the unit is installed but not enabled, and the cluster itself was deleted. See below. |
| `windows/DevBox-WSL-Keepalive.xml` | Windows Task Scheduler | **The most important file here.** See below. |

## dnsmasq stays, even though the names are gone

the name layer was **deleted** on 2026-08-12 - not parked, not dormant.
The tailnet split-DNS route had already been removed on 2026-08-08; four days
later the Traefik `Host()` routers it fed were deleted too, leaving zero `Host()`
rules on the box. Bringing names back therefore means re-adding the split-DNS
route **and** re-declaring a router for every service, i.e. a rebuild rather than
a switch. The `address=/test/` line in this file is harmless and stays, but it
only makes `.test` resolve **on this box and nowhere else**, and a name that
resolves still routes nothing.

**Do not disable dnsmasq.** It is the box's own resolver, and its remaining
load-bearing setting is `domain-needed`:

> Without it, a dotless name that leaks out of a container into a host process
> (`tempo`, `redis`, any bare compose service name) is forwarded upstream to a
> resolver that drops it silently instead of answering NXDOMAIN. Each lookup then
> hangs about 40 seconds - and because `getaddrinfo` runs on libuv's four-thread
> pool, a handful of them starve *every other lookup in the process*. That
> presents as unrelated database timeouts, which is an expensive way to learn
> about DNS.

The second reason to keep it is in [resolv.conf is immutable on
purpose](#resolvconf-is-immutable-on-purpose) below: dnsmasq answers AAAA for
`.test` with an immediate NODATA, while the upstream Windows resolver never
replies at all.

> The header comment inside `dnsmasq/dev.conf` still says "DORMANT NOTE
> (2026-08-08) … re-add the split-DNS route to bring names back; nothing here
> needs to change for that." **That is now wrong** - the routers it assumed
> still existed were deleted on 2026-08-12. This table row is the current
> statement; treat the file's own header as history.

## minikube is stopped, disabled and deleted (2026-08-12)

`minikube.service` is still installed, but it is **disabled** - minikube no
longer starts with the distro, and `just up` never touched it either way.

It was retired because it was measured doing nothing: `kubectl get pods -A`
showed only `kube-system`, the only Service in the cluster was the default
`kubernetes` ClusterIP, and nothing had ever been deployed to it - yet it had
been up 27 days holding **1,046 MB**, the largest single consumer of the box's
4,678 MB of container memory.

**The cluster was deleted** with `minikube delete`. `minikube profile list`
reports no profile at all. Restoring it is therefore a *recreate*, not a resume:

    minikube start                          # builds a NEW cluster, empty
    sudo systemctl enable --now minikube    # start-with-the-distro again

Nothing was lost, because nothing had ever been deployed - that was the whole
finding. If anything is ever deployed to it, revisit this: stopping is
reversible, deleting is not.

`just doctor` reports minikube's absence as a third state, `dim`, meaning
deliberately switched off rather than broken. Without that, every retirement
reads as a fault and the health report cries wolf until nobody reads it.

## What else went with it, 2026-08-12

Not host configuration, but the same day's work and the reason the box's numbers
moved. All three were **measured** idle before removal, not assumed:

| Retired | Evidence | Reclaimed |
|---|---|---|
| Kafka + Kafka-UI + Kafka-exporter | Zero topics | ~1,150 MB |
| Redis + Redis-exporter | Zero keys | ~30 MB |
| minikube | Zero non-system pods over 27 days | 1,046 MB |

Container memory went **4,678 MB → ~2,300 MB**; running containers **27 → 21**.
The compose files are kept so `just down` still cleans up an older deployment;
the volumes and images were deleted afterwards. Postgres is untouched and busier
than before - Keycloak's database now lives in it. Its superuser password was
rotated the same day, having still been the placeholder published in
`.env.example`.

Full detail, including what broke *after* the containers stopped, is in
[../README.md](../README.md#what-was-retired-2026-08-12).

## The keepalive task

WSL2 destroys the VM 60 seconds after the last Windows-side client disconnects.
An SSH session counts as such a client, which is why this box appeared to work
only while somebody was connected and died shortly after they left - taking
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

WSL rewrites `/etc/resolv.conf` whenever Windows' DNS configuration changes -
connecting the Windows Tailscale client is enough to trigger it - and
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
config - so `--providers.file.watch=true` stops meaning anything.

    docker compose -f edge/compose.yml up -d --force-recreate
