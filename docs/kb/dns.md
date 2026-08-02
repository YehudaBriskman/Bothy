# DNS — how `dev.test` works, and every way it fools you

## The chain (verified end-to-end 2026-07-21 from the phone)

```
client on tailnet → Tailscale split DNS: "test" → 100.117.176.85
                  → dnsmasq on the dev box (authoritative for .test)
                  → answers dev.test / *.dev.test = 100.117.176.85
client connects   → Traefik on :80 routes by Host header → service
```

- MagicDNS is on tailnet-wide, suffix `tail7e7e3b.ts.net` (so `yehuda-wsl.tail7e7e3b.ts.net` also works).
- Split DNS routes **the whole `.test` TLD** to the dev box, tailnet-wide.

## The consequence that keeps causing false alarms

**`.test` names only resolve for a client whose Tailscale tunnel + DNS are working.**
When a client's tailscale degrades, `dev.test` breaks *first* (DNS), then SSH — which
looks exactly like "the dev box is down". It never was, in any incident so far
(2026-07-21 ×2, 2026-08-02). First question, always: **is this device actually on the
tailnet, with a working tunnel?** → [runbook-cant-reach.md](runbook-cant-reach.md)

## Box-side configuration (fixed 2026-07-21, audit Phase 1.1)

- dnsmasq listens on `127.0.0.1` **and** `100.117.176.85`; authoritative for `.test`;
  upstreams: `server=/ts.net/100.100.100.100` and the WSL NAT resolver.
- `/etc/resolv.conf` points at local dnsmasq; **`generateResolvConf=false`** in
  `/etc/wsl.conf` so WSL stops rewriting it every boot (it used to, destroying any fix).
- **`accept-dns=false` must stay set on the WSL tailscale node** — enabling it lets
  tailscaled rewrite resolv.conf and clobber the whole setup.
- Side effect: dnsmasq has upstreams, so it answers non-`.test` queries for any tailnet
  client — an open resolver confined to the tailnet. Known, accepted.
- Config lives in `/etc/dnsmasq.d/dev.conf` — host config, tracked in the repo's `host/`
  dir since PR #8, but the *live* file is what matters.

## Client-side gotchas (all seen in real incidents)

| Symptom | Actual cause |
|---|---|
| `Invoke-WebRequest` to `*.dev.test` times out | .NET Happy-Eyeballs quirk (A record only). **Use `curl.exe`.** The site is fine. |
| Browser says NXDOMAIN, curl works | Chrome Secure DNS (DoH) bypasses the system resolver — it can never see `.test`. |
| `dev.test` dead + SSH dead on ONE device, fine elsewhere | That device's tailscale — see [incidents/2026-08-02](incidents/2026-08-02-thinkpad-tailscale.md). |
| `.test` doesn't resolve *inside* the dev box's own shell | Was finding #1 in the audit — fixed 2026-07-21; if it recurs, check resolv.conf + dnsmasq listen addresses. |
| Windows host can't resolve `.test` | Host must have Tailscale DNS on (`tailscale dns status` → "Tailscale DNS: enabled"). |
