# DevBox portproxy refresh - keeps Windows port-forwards tracking the WSL guest IP.
#
# WHY THIS EXISTS: the dev box is devssh's WSL2 distro; its NAT IP rotates on
# every WSL restart, and the netsh portproxy rules that forward host ports to it
# hold a literal IP - nothing refreshed them before, so every WSL restart could
# silently strand them (known-issues.md). This script converges the rules to the
# live guest IP and the tailnet+localhost-only listener policy.
#
# LISTENER POLICY (2026-08-08, pure-IP-over-tailscale switch): listeners bind
# 127.0.0.1 and the host's tailnet IP 100.93.197.10 ONLY - never 0.0.0.0. The
# LAN must not reach these ports; the tailnet is the access control.
#
# RUNS AS: SYSTEM (scheduled task DevBox-Portproxy-Refresh; at startup + every
# 15 min). Deliberately does NOT call wsl.exe: devssh's distro is invisible to
# other accounts, so the guest IP is discovered by probing instead - first the
# currently-configured target, then the vSwitch neighbor table. The dev box is
# identified by answering BOTH :80 (traefik) and :9090 (prometheus), which
# yr055's unrelated WSL VM on the same switch does not.
#
# Mirrored in the dev-box repo at host/windows/refresh-portproxy.ps1.

$ErrorActionPreference = 'Stop'
$Ports     = 80, 3000, 3001, 8080, 8081, 9000, 9090
$Listeners = '127.0.0.1', '100.93.197.10'
$LogFile   = 'C:\Users\Public\devbox\portproxy-refresh.log'

function Write-Log($msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogFile -Value $line
}

function Test-DevBox($ip) {
    foreach ($p in 80, 9090) {
        $c = New-Object Net.Sockets.TcpClient
        try {
            if (-not $c.ConnectAsync($ip, $p).Wait(1500)) { return $false }
        } catch { return $false } finally { $c.Dispose() }
    }
    return $true
}

# --- 1. Discover the live guest IP -----------------------------------------
$rules = @(netsh interface portproxy show v4tov4 |
    Select-String '^\s*([\d.]+)\s+(\d+)\s+([\d.]+)\s+(\d+)' |
    ForEach-Object { [pscustomobject]@{
        Listen = $_.Matches[0].Groups[1].Value
        Port   = [int]$_.Matches[0].Groups[2].Value
        Target = $_.Matches[0].Groups[3].Value } })

$target = $null
$known = $rules | Where-Object { $_.Port -eq 80 } | Select-Object -First 1
if ($known -and (Test-DevBox $known.Target)) { $target = $known.Target }

if (-not $target) {
    $candidates = Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.InterfaceAlias -like '*WSL*' -and $_.State -in 'Reachable','Stale','Permanent' } |
        Select-Object -ExpandProperty IPAddress -Unique
    foreach ($ip in $candidates) {
        if (Test-DevBox $ip) { $target = $ip; break }
    }
}

if (-not $target) {
    Write-Log "FAIL no live dev-box guest found (distro down? repetition will retry)"
    exit 1
}

# --- 2. Converge (no-op when already correct) -------------------------------
$desired = foreach ($p in $Ports) { foreach ($l in $Listeners) { "$l|$p|$target" } }
$actual  = $rules | Where-Object { $_.Port -in $Ports } |
    ForEach-Object { "$($_.Listen)|$($_.Port)|$($_.Target)" }
if (-not (Compare-Object $desired $actual)) {
    exit 0   # silent no-op: log only changes, the task fires every 15 min
}

foreach ($p in $Ports) {
    foreach ($l in '0.0.0.0', '127.0.0.1', '100.93.197.10') {
        netsh interface portproxy delete v4tov4 listenaddress=$l listenport=$p 2>$null | Out-Null
    }
    foreach ($l in $Listeners) {
        netsh interface portproxy add v4tov4 listenaddress=$l listenport=$p connectaddress=$target connectport=$p | Out-Null
    }
}

# --- 3. Verify ---------------------------------------------------------------
$c = New-Object Net.Sockets.TcpClient
try {
    $ok = $c.ConnectAsync('127.0.0.1', 80).Wait(2000)
} catch { $ok = $false } finally { $c.Dispose() }
Write-Log "converged $($Ports.Count) ports -> $target (localhost:80 probe: $(if ($ok) {'OK'} else {'FAILED'}))"
if (-not $ok) { exit 1 }
