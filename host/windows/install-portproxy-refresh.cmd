@echo off
rem Run this ONCE from an ELEVATED prompt. Registers the DevBox-Portproxy-Refresh
rem scheduled task (SYSTEM; boot + every 15 min) and runs it immediately, which
rem re-binds the port-forward listeners to 127.0.0.1 + 100.93.197.10 only.
schtasks /create /TN "DevBox-Portproxy-Refresh" /XML "C:\Users\Public\devbox\DevBox-Portproxy-Refresh.xml" /F
if errorlevel 1 exit /b 1
schtasks /run /TN "DevBox-Portproxy-Refresh"
timeout /t 8 /nobreak >nul
netsh interface portproxy show v4tov4
type C:\Users\Public\devbox\portproxy-refresh.log 2>nul
