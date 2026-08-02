# RUNBOOK — after the Windows host reboots

The box is expected to come up **by itself, with nobody logged in as devssh** — proven on
the 2026-08-01 cold boot ([always-on.md](always-on.md)). This runbook verifies it.

## Fastest check

From the phone (on tailnet): open **http://dev.test** → sign-in page or portal = PASS.

## Proper check (from yr055 on the PC)

Run **from an elevated terminal** (non-elevated cannot see the keepalive task and
false-reports `TASK MISSING`):

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\yr055\dev-box-postboot-check.ps1
```

Report lands in `C:\Users\yr055\dev-box-postboot-report.txt`. Healthy looks like:
vmmemWSL = 2 · `localhost`/`dev.test` → 401 · grafana → 302 · `yehuda-wsl` active ·
ForceDaemon true.

### Known checker defects (as of 2026-08-02)

1. **Hard-coded LAN IP `192.168.68.57` is stale** (now `.52`, DHCP — may change again).
   Its `000` probe and the FAIL verdict logic keyed on it are wrong. Judge by the other
   signals until the script is fixed to use the hostname/current IP.
2. **`TASK MISSING` when run non-elevated** — access-denied misread as absence.

## If it genuinely failed

```powershell
schtasks /run /TN "DevBox-WSL-Keepalive"     # elevated
```

- That brings it up → task fine, boot **trigger** didn't fire (small fix).
- It doesn't → log in as devssh once (always works), then investigate the task.
- **If devssh's password changed recently, that's the cause** — the stored task
  credential broke silently. Re-save it.

## Also affected by a reboot

- Host LAN IP may change (DHCP) — anything hard-coding it lies ([topology.md](topology.md)).
- WSL guest NAT IP rotates — irrelevant to normal access (Tailscale/names don't care).
- First SSH to the dev box after boot may hang seconds while the tunnel path establishes.
