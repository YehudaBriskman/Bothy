# Fencing the cloud node off the tailnet

**Status: proposed, not applied (2026-09-23).** The policy is
[`tailnet-acl-proposal.json`](tailnet-acl-proposal.json). Read this page first.

## What it is for

`SECURITY.md`'s largest accepted risk is that **nothing at the edge authenticates
a read**. The portal publishes an inventory of this box — names, images, ports,
health, labels, volumes, disk sizes, every metric and label value — to any device
on the tailnet, with no login. That was judged acceptable because the tailnet is
the boundary and every device on it is the owner's.

That is *almost* true. The tailnet has five nodes:

| node | what it is |
|---|---|
| `yehuda-wsl` | this box |
| `yehuda-thinkpad`, `yehuda-hs`, `iphone-14` | physically the owner's |
| **`oci-free-arm`** | **an Oracle free-tier ARM VM, reachable from the internet, also offering an exit node** |

Four of those are in a drawer or a pocket. The fifth is a cloud machine whose
attack surface is the public internet. If it is ever taken, the read plane of
this box is taken with it — not because the portal is weak, but because the
tailnet was assumed to be entirely trusted and one member of it is not.

**This is the cheap half of the fix.** The expensive half is putting `sso-viewer`
on the read plane, which costs a login on every device including the phone. The
cheap half removes the one member that is not in your hands, and it costs
nothing at all.

## Why an ACL and not SSO

The threat is not "an untrusted person on the tailnet". There is only one person
on this tailnet. The threat is "one node with a different risk profile from the
other four". An ACL addresses exactly that and nothing else. Putting SSO on the
read plane addresses a threat that does not exist here (a second user) at the
price of friction on every device, every day.

Revisit that reasoning the moment either fact changes: a second person joins the
tailnet, or the box is reachable from anywhere but it.

## The one way this goes wrong

**Tailscale ACLs are allow-only.** There is no deny rule. You express "everyone
except the cloud box" by granting everyone else and leaving it out — its absence
*is* the control.

Which means: **adding any `acls` block replaces the default allow-all policy.**
Until that block exists, every node can reach every node. The moment it exists,
anything you did not explicitly grant is refused, including the Tailscale SSH
that is the only way into this box (`machine/ssh.md`: port 22 here is Tailscale
SSH, `devssh` only — there is no openssh-server and no authorized_keys to fall
back to).

So the `ssh` block in the proposal is not decoration. Without it, saving the
policy ends your SSH session and does not let you start another.

## Applying it safely

1. **Keep a second way in before you touch anything.** The Windows host
   (`yehuda-hs`) can open a WSL shell directly, without the tailnet. Confirm that
   works *first* — it is the recovery path if the policy is wrong.
2. Open <https://login.tailscale.com/admin/acls>.
3. Paste the proposal. Use **Preview** — the console will show which connections
   the policy permits — and check that thinkpad → devbox on `:80` and `:22` are
   both still allowed.
4. Save.
5. From the thinkpad, immediately: `ssh devssh@yehuda-wsl` and
   `xh http://100.117.176.85/`. Both must still work.
6. From the box: `tailscale ping oci-free-arm` still succeeds (that is the
   tailnet control plane, not an ACL-governed connection), but a request *from*
   `oci-free-arm` to `100.117.176.85:80` must now fail.

If step 5 fails, revert in the console — it keeps the previous policy and
restoring it is one click. That is why step 1 exists: you need a shell that does
not depend on the thing you just changed.

## What this does not do

- It does not encrypt anything further. The tailnet is already WireGuard.
- It does not authenticate a read from your own devices. The portal stays
  anonymous to the four machines that keep access, which is the accepted risk,
  narrowed rather than closed.
- It does not stop you using `oci-free-arm` as an exit node. That is traffic
  leaving through it, not entering the tailnet.
