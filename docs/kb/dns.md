# DNS - RETIRED (dormant 2026-08-08, deleted 2026-08-12)

> **The name layer is gone, not paused.** Access is **pure IP over tailscale**:
> `http://100.117.176.85:<port>` (port table in [access.md](access.md)), SSH
> unchanged at `devssh@100.117.176.85`. MagicDNS (`yehuda-wsl.tail7e7e3b.ts.net`)
> still works - it never depended on any of this.
>
> **What state each piece is in (verified 2026-08-12)**
>
> | Piece | State | Note |
> |---|---|---|
> | Tailnet split-DNS route `test → 100.117.176.85` | **deleted 2026-08-08** | admin console; the only off-box change |
> | Traefik `Host()` routers | **deleted 2026-08-12** | the router table went 22 → 6; **zero** Host rules remain, and none exist in any compose or dynamic file |
> | Traefik dashboard (`a service hostname`) | **deleted 2026-08-12** | it was leaking a credential - see [lessons.md](lessons.md) |
> | SSO / oauth2-proxy | **parked**, container down | being replaced by Keycloak in a separate change; `auth/compose.yml` still carries a stale `Host(a service hostname)` label ([known-issues.md](known-issues.md)) |
> | dnsmasq on the box | **RUNNING, unchanged** | it is the box's own resolver (`/etc/resolv.conf` → 127.0.0.1, `generateResolvConf=false`, `accept-dns=false`). Only its `.test` *audience* is gone. **Do NOT disable it.** |
>
> **This is no longer a re-enable manual**
>
> The 2026-08-08 version of this header promised that re-adding one console route
> would bring names back instantly. **That stopped being true on 2026-08-12.**
> The routers that the DNS fed no longer exist anywhere; restoring names now means:
>
> 1. re-add the split-DNS route (admin console → DNS → Nameservers → Add
>    `100.117.176.85`, restricted to domain `test`) - the only step that is still
>    a switch; then
> 2. **re-author a `Host()` router for every service, from scratch** - there is
>    nothing left to un-comment; and
> 3. un-park the SSO (or whatever replaces it), including a fresh OAuth callback.
>
> That is a rebuild. Weigh it against the fact that deleting the layer cost
> nothing measurable: every browser-facing service already published a host port,
> and a 20-check verification harness passed 20/20 afterwards.
>
> **The trap this leaves:** dnsmasq still answers `address=/test/`, so on the box
> itself `getent hosts the name layer` returns `100.117.176.85` and `curl
> the portal/` returns 200 - the portal catch-all answers everything. Neither
> is evidence that a name works. From any other device, `.test` is NXDOMAIN, and
> that is expected.
>
> Everything below is how the DNS half worked while live. It is still accurate
> about dnsmasq, and it is still the manual for step 1 above.

## How the name layer worked, and every way it fooled you

_Historical from here down - accurate as of 2026-08-08, kept as the record._

### The chain (verified end-to-end 2026-07-21 from the phone)

```
client on tailnet → Tailscale split DNS: "test" → 100.117.176.85
                  → dnsmasq on the dev box (authoritative for .test)
                  → answers the name layer / the name layer = 100.117.176.85
client connects   → Traefik on :80 routes by Host header → service
```

- MagicDNS is on tailnet-wide, suffix `tail7e7e3b.ts.net` (so `yehuda-wsl.tail7e7e3b.ts.net` also works).
- Split DNS routes **the whole `.test` TLD** to the dev box, tailnet-wide.

### The consequence that keeps causing false alarms

**`.test` names only resolve for a client whose Tailscale tunnel + DNS are working.**
When a client's tailscale degrades, the name layer breaks *first* (DNS), then SSH - which
looks exactly like "the dev box is down". It never was, in any incident so far
(2026-07-21 ×2, 2026-08-02). First question, always: **is this device actually on the
tailnet, with a working tunnel?** → [runbook-cant-reach.md](runbook-cant-reach.md)

### Box-side configuration (fixed 2026-07-21, audit Phase 1.1)

- dnsmasq listens on `127.0.0.1` **and** `100.117.176.85`; authoritative for `.test`;
  upstreams: `server=/ts.net/100.100.100.100` and the WSL NAT resolver.
- `/etc/resolv.conf` points at local dnsmasq; **`generateResolvConf=false`** in
  `/etc/wsl.conf` so WSL stops rewriting it every boot (it used to, destroying any fix).
- **`accept-dns=false` must stay set on the WSL tailscale node** - enabling it lets
  tailscaled rewrite resolv.conf and clobber the whole setup.
- Side effect: dnsmasq has upstreams, so it answers non-`.test` queries for any tailnet
  client - an open resolver confined to the tailnet. Known, accepted.
- Config lives in `/etc/dnsmasq.d/dev.conf` - host config, tracked in the repo's `host/`
  dir since PR #8, but the *live* file is what matters.

### Client-side gotchas (all seen in real incidents)

| Symptom | Actual cause |
|---|---|
| `Invoke-WebRequest` to the name layer times out | .NET Happy-Eyeballs quirk (A record only). **Use `curl.exe`.** The site is fine. |
| Browser says NXDOMAIN, curl works | Chrome Secure DNS (DoH) bypasses the system resolver - it can never see `.test`. |
| the name layer dead + SSH dead on ONE device, fine elsewhere | That device's tailscale - see [incidents/2026-08-02](incidents/2026-08-02-thinkpad-tailscale.md). |
| `.test` doesn't resolve *inside* the dev box's own shell | Was finding #1 in the audit - fixed 2026-07-21; if it recurs, check resolv.conf + dnsmasq listen addresses. |
| Windows host can't resolve `.test` | Host must have Tailscale DNS on (`tailscale dns status` → "Tailscale DNS: enabled"). |
