<!--
Security vulnerabilities do not belong in a pull request either — see SECURITY.md.
-->

## What changed

<!-- One or two sentences. Which stack, which files. -->

## Why

<!-- The problem this solves. If it changes a router rule, a compose env var, or
     anything under "Load-bearing design rules" in SECURITY.md, say so here and
     explain why the boundary still holds. -->

## How it was verified

<!-- The actual commands you ran and what you saw. "Should work" is not
     verification. e.g. `just up-edge && just doctor`, a curl with its status
     code, a screenshot for anything visual (jsdom cannot see layout). -->

## Checklist

- [ ] No secrets or personal identifiers added — no real hostnames, IP addresses, tailnet names, e-mail addresses, tokens or passwords, in code, comments, docs or commit messages
- [ ] `just doctor` still passes
- [ ] Portal typechecks and builds if touched — `cd apps/portal-next/web && npx tsc -b --noEmit && npm run build`
- [ ] Every compose file I changed still parses — `docker compose -f <file> config -q`
- [ ] New browser-reachable services follow the access model: a published port listed in `just urls` (current pure-IP model) **and** the dormant `*.dev.test` router labels for when names return
- [ ] New or changed behaviour is reflected in the README, SECURITY.md or the relevant comment
