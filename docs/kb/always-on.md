# Always-on — why the box survives with nobody logged in

## The original disease (2026-07-21, [incident](incidents/2026-07-21-wsl-idle-timeout.md))

WSL2 destroys its utility VM **60 seconds after the last Windows-side client disconnects**
(devssh's `.wslconfig` sets no `vmIdleTimeout`). An SSH session counts as a client — so the
box only worked while someone was SSH'd in, then died 60s later, taking docker, all ~25
containers and the in-WSL Tailscale node with it. That is why it looked "flaky" for weeks.

## The cure — three pieces, all required

1. **Scheduled task `DevBox-WSL-Keepalive`** (the core): runs as `devssh` with a stored
   password (`LogonType=Password`, `RunLevel=Highest`), triggers *At startup* + *At logon
   of devssh*, no execution time limit, `MultipleInstances=IgnoreNew`, restart 5×/1min.
   Action: `powershell -NoProfile -WindowStyle Hidden -Command "wsl.exe -d Ubuntu -u root -e sleep infinity"`
   — a permanent client that holds the VM open.
2. **Inside the distro:** systemd is PID 1 and `docker.service` is enabled — once the
   distro is up, the whole stack rises with it. `tailscale set --ssh=true` gives SSH access
   with no sshd.
3. **On the Windows host:** Tailscale **`ForceDaemon: true`** (unattended mode) — without
   it the host's tailscale died on logout, which caused an earlier outage.

## Proof status: PASSED ✅ (2026-08-01)

The one untested piece — a genuine cold boot with nobody logging in as devssh — happened
2026-08-01 14:06 (the [ethernet-incident](incidents/2026-08-01-ethernet-ndis.md) reboot):
devssh's WSL VM started **16 seconds after boot**, and 28h later the containers, HTTP
services, SSO and Tailscale node were all still up with only yr055 on console. Verified
2026-08-02 via checker + event logs + tailscaled logs.

## How it can still break (watch these)

| Risk | Symptom | Detection / fix |
|---|---|---|
| **devssh's Windows password changes** | Task fails **silently** at next boot; box never comes up | After any password change: re-save the task credential. Post-reboot: run the checker ([runbook-post-reboot.md](runbook-post-reboot.md)) |
| Task deleted/disabled | Same | `schtasks /query /TN "DevBox-WSL-Keepalive"` **from an elevated prompt** (non-elevated says "Access is denied", which is normal — see [access.md](access.md)) |
| WSL update changes idle behavior | VM dies ~60s after last client despite task | `Get-Process vmmemWSL` count should be 2; check task is actually running |
| Manual recovery, any time | — | Elevated: `schtasks /run /TN "DevBox-WSL-Keepalive"` — or log in as devssh once (always works) |

## Quick health check (from yr055, any time)

```powershell
(Get-Process vmmemWSL -ErrorAction SilentlyContinue).Count   # want: 2
curl.exe -s -o NUL -w "%{http_code}" http://dev.test/        # want: 401 (or 200/302)
tailscale status | findstr yehuda-wsl                        # want: active or idle, not offline
```
