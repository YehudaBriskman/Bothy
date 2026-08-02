# Access — every way into the dev box, and why the obvious ones fail

_See [topology.md](topology.md) for what these machines are._

## The front door (use this)

```bash
ssh devssh@100.117.176.85          # or devssh@yehuda-wsl.tail7e7e3b.ts.net, or devssh@dev.test
```

Lands in `~/stacks`. Rules that are not obvious:

- **Port 22 on the dev box is Tailscale SSH, not OpenSSH.** `openssh-server` is not
  installed in the distro; tailscaled itself serves the port (`RunSSH: true`). There is no
  `sshd_config`, no `authorized_keys`, no host-key debugging to do — auth is tailnet
  identity + ACL. Client keys are irrelevant; auth method is "none".
- **The only user is `devssh`** (uid 1000, passwordless sudo). Any other username —
  including `yr055` — fails with `unknown user` at user lookup. This burned us 2026-08-02
  at 17:55: it looks like a server problem, it's a typo.
- The client must be **on the tailnet with a working tunnel** — if `dev.test` doesn't
  resolve either, suspect the client, not the box ([runbook-cant-reach.md](runbook-cant-reach.md)).
- No check-mode in the SSH policy (verified from logs 2026-08-02) — a browser re-auth
  prompt is not expected; access is granted directly.

## The other port 22 — the Windows host

```bash
ssh devssh@100.93.197.10       # the HOST's Windows sshd, devssh's WINDOWS password
```

Historic path, still active (last used from the laptop 2026-08-02 12:38). It lands in
Windows, not in the dev stack. Don't confuse the two 22s: same machine physically,
different OS answering depending on which tailnet IP you dialed.

## From yr055 on the host itself, without SSH

devssh's WSL distro is registered in **devssh's registry hive** — `wsl -l` as yr055 will
never list it, elevated or not. To run something inside it from another account, use an
interactive-token scheduled task (no password needed while devssh is logged on):

```powershell
schtasks /create /TN "devbox-run" /TR "cmd /c wsl.exe -d Ubuntu -e bash /mnt/c/Users/Public/devbox/x.sh > C:\Users\Public\devbox\out.txt 2>&1" /SC ONCE /ST 23:59 /RU devssh /IT /F
schtasks /run /TN "devbox-run"
```

Write the `.sh` with **LF endings** (`sed -i 's/\r$//'`) — CRLF breaks bash.
(When devssh is *not* logged on, the `/IT` trick doesn't work — but Tailscale SSH does.)

## Elevation map — what yr055 can and cannot see

| Thing | Non-elevated yr055 | Elevated |
|---|---|---|
| `C:\Users\devssh\*` | access denied | readable |
| `DevBox-WSL-Keepalive` task | **"Access is denied"** — looks MISSING but isn't | visible, incl. LastRunTime |
| `C:\ProgramData\Tailscale\` (service logs) | ACL-locked | readable (copies from 2026-08-02 in `C:\Users\yr055\ts-log-copy\`) |
| Owners of devssh's processes (vmmemWSL etc.) | blank/denied | visible |

**Rule:** "Access is denied" ≠ "does not exist". The postboot checker reported
`TASK MISSING` for exactly this reason when run non-elevated.

## Web access

All `*.dev.test` services go through Traefik on :80 with GitHub SSO in front of most of
them ([architecture.md](architecture.md)). Expected codes: `dev.test` → **401** when not
signed in (that means UP), grafana → 302. Test with `curl.exe`, never `Invoke-WebRequest`
([lessons.md](lessons.md)).
