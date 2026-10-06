# Access - every way into the dev box, and why the obvious ones fail

_See [topology.md](topology.md) for what these machines are._

## The front door (use this)

```bash
ssh devssh@100.117.176.85          # or devssh@yehuda-wsl.tail7e7e3b.ts.net
```

_(`devssh@<base-domain>` worked until 2026-08-08 and is now resolvable only from the box
itself - use the IP or the MagicDNS name.)_

Lands in `~/stacks`. Rules that are not obvious:

- **Port 22 on the dev box is Tailscale SSH, not OpenSSH.** `openssh-server` is not
  installed in the distro; tailscaled itself serves the port (`RunSSH: true`). There is no
  `sshd_config`, no `authorized_keys`, no host-key debugging to do - auth is tailnet
  identity + ACL. Client keys are irrelevant; auth method is "none".
- **The only user is `devssh`** (uid 1000, passwordless sudo). Any other username -
  including `yr055` - fails with `unknown user` at user lookup. This burned us 2026-08-02
  at 17:55: it looks like a server problem, it's a typo.
- The client must be **on the tailnet with a working tunnel**. (Before 2026-08-08 a
  failing name-layer lookup was the first symptom of that; names are retired now, so
  probe the IP instead - [runbook-cant-reach.md](runbook-cant-reach.md).)
- **Check-mode appeared in the SSH policy by 2026-08-08** (contradicting the 08-02
  check): a session may print `# To authenticate, visit: https://login.tailscale.com/a/…`
  and wait. Interactive use: click it once, it caches. Unattended use stalls on it -
  either flip the ACL SSH rule to `action: accept` in the admin console, or expect it.
- **If SSH hangs at `expecting SSH2_MSG_KEX_ECDH_REPLY`:** that's the large-packet
  blackhole, not auth. Emergency door: force a small handshake with
  `ssh -o KexAlgorithms=curve25519-sha256 -o HostKeyAlgorithms=ssh-ed25519 devssh@100.117.176.85`
  then restart tailscaled on the box -
  [incidents/2026-08-08](incidents/2026-08-08-wsl-node-large-packet-blackhole.md).

## The other port 22 - the Windows host

```bash
ssh devssh@100.93.197.10       # the HOST's Windows sshd, devssh's WINDOWS password
```

Historic path, still active (last used from the laptop 2026-08-02 12:38). It lands in
Windows, not in the dev stack. Don't confuse the two 22s: same machine physically,
different OS answering depending on which tailnet IP you dialed.

## From yr055 on the host itself, without SSH

devssh's WSL distro is registered in **devssh's registry hive** - `wsl -l` as yr055 will
never list it, elevated or not. To run something inside it from another account, use an
interactive-token scheduled task (no password needed while devssh is logged on):

```powershell
schtasks /create /TN "devbox-run" /TR "cmd /c wsl.exe -d Ubuntu -e bash /mnt/c/Users/Public/devbox/x.sh > C:\Users\Public\devbox\out.txt 2>&1" /SC ONCE /ST 23:59 /RU devssh /IT /F
schtasks /run /TN "devbox-run"
```

Write the `.sh` with **LF endings** (`sed -i 's/\r$//'`) - CRLF breaks bash.
(When devssh is *not* logged on, the `/IT` trick doesn't work - but Tailscale SSH does.)

## Elevation map - what yr055 can and cannot see

| Thing | Non-elevated yr055 | Elevated |
|---|---|---|
| `C:\Users\devssh\*` | access denied | readable |
| `DevBox-WSL-Keepalive` task | **"Access is denied"** - looks MISSING but isn't | visible, incl. LastRunTime |
| `C:\ProgramData\Tailscale\` (service logs) | ACL-locked | readable (copies from 2026-08-02 in `C:\Users\yr055\ts-log-copy\`) |
| Owners of devssh's processes (vmmemWSL etc.) | blank/denied | visible |

**Rule:** "Access is denied" ≠ "does not exist". The postboot checker reported
`TASK MISSING` for exactly this reason when run non-elevated.

## Web access - pure IP:port (SSO parked; the name layer deleted 2026-08-12)

Canonical base: `http://100.117.176.85:<port>` (MagicDNS alias
`yehuda-wsl.tail7e7e3b.ts.net:<port>` works too). Mirrors via Windows portproxy:
`http://100.93.197.10:<port>` from the tailnet, `localhost:<port>` on the host -
**LAN is deliberately not served.**

**Logins (since 2026-08-08): one unified dev login everywhere a login exists** -
username is the owner's gmail address; the password is `DEV_LOGIN_PASSWORD` in the
box's gitignored `~/stacks/.env` (never in this KB or the public repo).

> **The port table that stood here is RETIRED (2026-09-23).** It listed Wiki.js
> on 3001, Dozzle on 8080, Kafka-UI on 8081, Portainer on 9000 and Prometheus on
> 9090. Wiki.js, Dozzle, Kafka-UI and Portainer were deleted on 2026-08-18 and
> Prometheus was replaced by VictoriaMetrics on 8428 on 2026-09-17, so five of
> its eleven rows sent a reader at a port nothing answers, while Headlamp (8110)
> and the file sandbox (8100) were missing from it entirely.
>
> **`just urls`, run on the box, is the authority** - it reads the address from
> `tailscale` at run time and is maintained beside the compose files that publish
> the ports. A second copy here could only ever be a snapshot of it, and this one
> proved the point by going a month out of date without anybody noticing. The two
> facts from that table worth keeping are below.

- **Port 80 is the Traefik catch-all** serving the portal. **200 is expected; a
  401 means regression.** It answers *every* path and host, so a 200 there proves
  nothing about any other service - verify a service on its own published port,
  and check the bytes as well as the status code.
- **The LAN is deliberately not served.** Everything is tailnet or loopback.

Test with `curl.exe`, never `Invoke-WebRequest` ([lessons.md](lessons.md)), and check
**bytes, not just codes** - "200 with 0 bytes" is the large-packet blackhole
([incidents/2026-08-08](incidents/2026-08-08-wsl-node-large-packet-blackhole.md)).

**There is no Traefik dashboard any more** (deleted 2026-08-12 - it leaked a
credential, [lessons.md](lessons.md)). For the router table:
`http://100.117.176.85/-/api/traefik/http/routers`, or the portal's Routes page.
