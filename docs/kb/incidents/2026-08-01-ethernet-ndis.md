# Incident 2026-08-01 — host Ethernet dead (NDIS pause-wedge)

**Status: RESOLVED** (suspected trigger removed; no recurrence as of 2026-08-02).

## Symptom
The Windows host (`Yehuda-HS`) lost Ethernet/DHCP entirely — with it, the LAN, and
everything hosted on the machine.

## Root cause
An NDIS pause-wedge killed DHCP on the Realtek NIC; the NIC was found **admin-disabled**.
Behind it: PnP storms from a **failing USB webcam**, which has since been physically
unplugged. (Event logs on 2026-08-02 show zero Kernel-PnP events in 8h — the removal is
holding.)

## Resolution & side effects
- Machine rebooted 2026-08-01 **14:06** — which doubled as the long-awaited **cold-boot
  test of the keepalive fix: PASSED** ([../always-on.md](../always-on.md)).
- The new DHCP lease moved the host's LAN IP **192.168.68.57 → 192.168.68.52** — which
  later made the postboot checker false-FAIL (stale hard-coded IP,
  [../known-issues.md](../known-issues.md)) and is a standing reminder that LAN IPs rot
  ([../lessons.md](../lessons.md) #10).

## Watch for recurrence
Symptoms would be: NIC shows `Disabled`/no DHCP lease, NDIS warnings in the System event
log, PnP event storms. If seen: check what USB device was recently attached.
