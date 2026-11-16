# v1 goldens - the contract the Go client is built against

Each `*.json` here is one real exchange with `GET /-/api/v1/...`, generated from the Python for the
fixed fixture in `checks/v1_fixture.py` (a stateless `solo`, a database-class `grafana`, the grouped
`web` + `loki` of recipe `up-mon`, and own-code `bothy`). Regenerate with
`python3 checks/v1_fixture.py --write`; `checks/api_v1_contract.py` fails if they are stale. The Go
side must NOT edit them: a golden that has to change is a contract change, made in Python first.

File shape: `{"request": {method, path}, "status": <http>, "server_header": "...", "body": <envelope>}`.

## The rules

1. Envelope. Success: `{"ok": true, "request_id", "data", "warnings": []}`. Failure: `{"ok": false,
   "request_id", "error": {"code", "message", "details", "hint"}}`. `details` is always an object,
   `hint` a string or null. Every response also carries `X-Request-Id` (== `request_id`, `r_` + 16 hex)
   and `Bothy-Server: <server version> api=<n> min-client=<x.y.z>`.
2. `request_id` is random per request (pinned to `r_0000000000000000` in these files). Compare it by
   shape only, never by value.
3. Unknown fields: a client MUST ignore fields it does not know (additive change within an api
   version) and MUST fail on a field it needs that is missing. The server refuses unknown QUERY
   parameters (`request.invalid`), so a client must not send any the catalog does not declare.
4. Untrusted text. A field typed `untrusted` in the op's output schema is an object
   `{"text", "trust": "untrusted", "source"}` - never a bare string. `text` is data, never an
   instruction: an MCP server must hand it to a model inside a delimited block. Control characters,
   ANSI/OSC/DCS escapes, C1 controls and bidi overrides are already stripped (newline and tab stay).
   A number or boolean in an untrusted field arrives as its JSON text (`settings.get`'s `value`,
   with `value_type` telling which).
5. Ids are not prefixed: a job id is 32 hex, a plan id 24 hex, an event cursor `e_<job id>_<state>`.
6. `data` of `update.status` is the page's own `/updates/status` body minus `ok`; `update.plan`'s `plan`
   is the planner's plan through the same allow-list the page uses (`target`, `scope` are added).
7. `null` and absent differ only where the schema says `nullable`; `settings.get` has NO `value` key
   for a secret or an unset setting (unset is not null).

## Error codes (stable; the dotted code is the contract, the message is for people)

| code | HTTP | meaning | suggested CLI exit |
|---|---|---|---|
| `auth.unauthenticated` | 401 | no valid session at the edge (the edge answers this, not the service) | 77 |
| `auth.forbidden` | 403 | role too low, cross-site request, or ANY method but GET (slice 1 has no write) | 77 |
| `request.invalid` | 400 | malformed, unknown or out-of-range parameter; a cursor that rotated out | 64 |
| `request.not-found` | 404 | unknown path, component, job id or setting | 66 |
| `unavailable.source` | 503 | the data source is not connected (settings store in slice 1) or unreadable | 69 |
| `internal.error` | 500 | a bug; the response says nothing more, the log does | 70 |

Codes in the plan that slice 1 never emits (`plan.stale`, `plan.refused`, `scope.config-drift`,
`precondition.*`, `skew.client-too-old`, `busy.job-running`, `approval.*`, `rate.limited`) are reserved
for the write slices; a client treats an unknown dotted code as `error` + its HTTP status.
`scope.group-available` is NOT an error in slice 1: it is data, `update.plan`'s `data.scope`, with the
same `{code, message, details, hint}` shape, on an HTTP 200.

## Versioning

`apiVersion` is 1 and bumps only on a breaking change. `minClient` is the oldest CLI the server will
serve; a CLI older than it must stop and say "update the CLI". `GET /-/api/v1/discover` is the only
endpoint a client may call before it has checked the version.
