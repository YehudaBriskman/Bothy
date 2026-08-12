# Security and privacy

_Status as of 2026-08-10._

## The rule

**No credential is ever committed.** Where a config file must carry one,
generate it from the environment, gitignore the output, and commit a redacted
example instead. Run secret scanning on push and periodically over full history.

**A committed example must not collide with the real file.** If a loader merges
every file in a directory, an example that declares the same names as the real
config **overwrites it**. This is a real, silent failure: the routing is
reported healthy, the names resolve, and the credential is the placeholder
string. Make the example comments-only, or give it distinct names.

**Prove an auth boundary with a probe that can fail.** See
[qa-and-verification](qa-and-verification.md). Confirming a boundary with a
request that would return the same thing either way proves nothing.

**Exact paths, never prefixes, when proxying an administrative API.** A prefix
rule is how a read-only surface quietly becomes a write surface. Add an endpoint
only as a new exact path, and only after confirming its response body carries no
secrets.

**Enumerate every storage key** with its purpose and lifetime.

**Third-party embeds are a decision, not a default.** Each one gets a reason and
a note on what it can see. Analytics is a position to take explicitly — none, or
self-hosted and consent-gated.

**Serve the headers**: content security policy, referrer policy, content-type
options, frame ancestors, permissions policy. Verify with a probe rather than by
reading the config.

**Public repository discipline.** Scrub addresses, hostnames and usernames from
screenshots and docs. Read identity at run time instead of writing it down.

## Checklist

See [CHECKLIST.md § 24](../CHECKLIST.md#24-security-and-privacy).

## What Bothy decided, and why

**The data plane is the security boundary, and it is a set of exact paths.**
The portal reads three upstreams through same-origin routes. Every rule is an
exact path match. This is not style — it is the entire control: the container
socket proxy gates by endpoint *family*, so a prefix loose enough to match one
container endpoint also matches the one whose response body contains every
container's environment, including database and dashboard passwords.

**The metrics route is generated, not committed.** Prometheus grew basic auth
when the SSO was parked, and a browser cannot hold a credential, so the edge
injects the header on the page's behalf. The file that carries it is written
from the environment by a script, gitignored, and mode 600. A redacted example
sits beside it, **comments-only** — because the first version of that example
declared the same router and middleware names as the real file, and the file
provider merged it on top, replacing the real credential with the placeholder.
Every metrics query returned 401 while the router still reported "enabled".

**Only two metrics endpoints are routed**, both read-only. The same instance
also serves administrative endpoints, so a prefix rule would have handed those to
anything on the network.

**The brand line reads the hostname at run time** rather than embedding the
address, because this repository is public.

**No analytics, no third-party scripts, no CDN assets.**

**Storage keys:** one, `portal-theme`.

**Known gaps**, tracked in
[reference/open-questions.md](../reference/open-questions.md): no content
security policy is served, and the pre-paint theme script would need hashing
before a strict one could be. No other headers are set either.

## Dead ends

- **A live example config in a watched directory.** Overwrote the real one. See
  above.
- **Relying on the socket proxy's own allowlist** to keep environment variables
  private. It gates by family; the exact-path rules are the actual control.

## How this is verified

- The regression test for the boundary asserts that a container's detail
  endpoint is *not* reachable through the proxy.
- After regenerating the metrics route, confirm a query returns JSON and that
  unrouted paths fall through to the app rather than to the upstream.
- Probe the headers rather than reading the config.
