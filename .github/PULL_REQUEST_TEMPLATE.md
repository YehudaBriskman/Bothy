<!--
Security vulnerabilities do not belong in a pull request either - see SECURITY.md.
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

- [ ] No secrets or personal identifiers added - no real hostnames, IP addresses, tailnet names, e-mail addresses, tokens or passwords, in code, comments, docs or commit messages
- [ ] `just doctor` still passes
- [ ] Portal typechecks and builds if touched - `cd apps/portal-next/web && npx tsc -b --noEmit && npm run build`
- [ ] Every compose file I changed still parses - `docker compose -f <file> config -q`
- [ ] New browser-reachable services follow the access model: a **published host port**, checked free against `just urls`, added to the `urls` recipe, with its own `DEV_LOGIN_*` login. **No `Host()` rule** - the name layer was deleted 2026-08-12 and such a router matches nothing
- [ ] I did not attach `sso@file` / `sso-errors@file` to a router. They are defined and deliberately unattached while identity is rebuilt - see SECURITY.md rule 1
- [ ] No doubled braces anywhere in `edge/dynamic/`, including in comments - Traefik templates those files before parsing and one silently blanks the whole file
- [ ] If I touched `edge/dynamic/`, I ran the boundary check and pasted the output. **Content type, not status code** - the catch-all returns 200 for everything, so only the type can fail:
      `curl -s -o /dev/null -w '%{content_type}\n' http://127.0.0.1/-/api/docker/containers/$(docker ps -q | head -1)/json` → must be `text/html`
- [ ] New or changed behaviour is reflected in the README, SECURITY.md, docs/ARCHITECTURE.md or the relevant comment
