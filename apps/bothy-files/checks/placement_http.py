#!/usr/bin/env python3
"""Placement rules through the config forms, over a copy of the real placement.yml.

Run: python3 checks/placement_http.py      (needs ruamel.yaml - run.sh finds it)

Settings > Services & placement edits apps/bothy-collector/placement.yml through
/config/fields and /config/patch, with a new field kind, `placement-rule`. This
drives the REAL bothy-files handler with the SHIPPED policy (container paths
rewritten, as config_http.py does) against a copy of the real file.

── what it asserts ─────────────────────────────────────────────────────────

  located        every written section/subgroup/title/group, keyed by the rule's
                 match list; a key a rule does not write is not a site
  scoped         `paths` keeps placement fields out of a compose file - not listed
                 by GET, refused by POST (403) before the file is read
  patched        one line changes, every comment survives byte-identical, the
                 answer says the COLLECTOR applies it, one audit line
  refused        a value YAML would restructure (': ', ' #'); a key the rule does
                 not have (404); two rules with one match list (422, whole file)
"""
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
SVC = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SVC))
sys.path.insert(0, SVC)

TMP = tempfile.mkdtemp(prefix="bothy-placement-api-")
ROOT = os.path.join(TMP, "stacks")
TRASH = os.path.join(TMP, "trash")
AUDIT = os.path.join(TMP, "audit", "patches.log")
os.makedirs(ROOT)
os.makedirs(TRASH)
PLACEMENT = "apps/bothy-collector/placement.yml"
for rel in (PLACEMENT, "edge/compose.yml"):
    dst = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(os.path.join(REPO, rel), dst)
with open(os.path.join(ROOT, "apps/bothy-collector/twins.yml"), "w") as fh:
    fh.write("rules:\n  - match: [project:a]\n    section: bothy\n  - match: [project:a]\n    section: projects\n")

POLICY_SRC = open(os.path.join(SVC, "policy.toml"), encoding="utf-8").read()
for want, got in (('path = "/repos/stacks"', ROOT),
                  ('path = "/var/lib/bothy/config-trash"', TRASH),
                  ('path = "/repos/notes"', os.path.join(TMP, "notes")),
                  ('path = "/repos/projects"', os.path.join(TMP, "projects")),
                  ('path = "/repos/home"', os.path.join(TMP, "home")),
                  ('path = "/var/lib/bothy/trash"', os.path.join(TMP, "editor-trash"))):
    if want not in POLICY_SRC:
        sys.exit(f"cannot find {want!r} in policy.toml - this check is out of step with it")
    os.makedirs(got, exist_ok=True)
    POLICY_SRC = POLICY_SRC.replace(want, f'path = "{got}"')
# The twins file needs the same scope as the real one, or it would be refused for
# the wrong reason (not in `paths`) and the ambiguity case would prove nothing.
POLICY_SRC = POLICY_SRC.replace('paths = ["apps/bothy-collector/placement.yml"]',
                                'paths = ["apps/bothy-collector/placement.yml", "apps/bothy-collector/twins.yml"]')
POLICY = os.path.join(TMP, "policy.toml")
open(POLICY, "w", encoding="utf-8").write(POLICY_SRC)
os.environ.update({"POLICY_FILE": POLICY, "CONFIG_AUDIT_LOG": AUDIT,
                   "AUDIT_LOG": os.path.join(TMP, "audit", "writes.log"), "PORT": "0"})

import app  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

srv = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
ADDR = srv.server_address
bad = 0


def say(ok: bool, label: str, detail: str = "") -> None:
    global bad
    if not ok:
        bad += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label:<60} {detail}")


def call(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    c = http.client.HTTPConnection(*ADDR, timeout=10)
    headers = {"X-Auth-Request-Email": "devssh@example.test"}
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    c.request(method, path, payload, headers)
    r = c.getresponse()
    raw = r.read()
    c.close()
    try:
        return r.status, json.loads(raw)
    except json.JSONDecodeError:
        return r.status, {"raw": raw[:200].decode(errors="replace")}


def text(rel: str) -> str:
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


print("── located, keyed by the rule's match list ──────────────────────────")
code, doc = call("GET", f"/config/fields?root=stacks&path={PLACEMENT}")
say(code == 200, "GET /config/fields on placement.yml", str(code))
sites = {(f["service"], f["field"]): f for f in doc.get("fields", [])}
say(sites.get(("project:auth", "placement.section"), {}).get("value") == "bothy",
    "project:auth's section is found, value read", str(sites.get(("project:auth", "placement.section"))))
say(("project:auth", "placement.title") not in sites, "a key the rule does not write is not a site")
sonar = "container:thales-sonarqube,container:thales-sonarqube-db"
say(sites.get((sonar, "placement.title"), {}).get("value") == "SonarQube",
    "a two-container rule is one identity", str(sites.get((sonar, "placement.title"))))
say(all(f["kind"] == "placement-rule" for f in doc.get("fields", [])), "every site is kind placement-rule")
say(sorted(doc.get("patchable", [])) == ["dev.portal.project", "placement.group", "placement.section",
                                         "placement.subgroup", "placement.title"],
    "placement.yml may be patched in the four placement fields", str(doc.get("patchable")))
MTIME = doc.get("mtime")

print()
print("── scoped to the one file ───────────────────────────────────────────")
code, doc = call("GET", "/config/fields?root=stacks&path=edge/compose.yml")
say(code == 200 and doc.get("patchable") == ["dev.portal.project"],
    "a compose file does not even list placement fields", str(doc.get("patchable")))
code, doc = call("POST", "/config/patch", {"root": "stacks", "path": "edge/compose.yml",
                                           "field": "placement.section", "value": "x", "baseMtime": 1})
say(code == 403 and "not patchable in edge/compose.yml" in doc.get("error", ""),
    "and refuses one there", f"{code} {doc.get('error')}")

print()
print("── a patch: one line, comments intact, the collector applies it ─────")
before = text(PLACEMENT)
comments_before = [ln for ln in before.splitlines() if ln.lstrip().startswith("#")]
code, doc = call("POST", "/config/patch", {"root": "stacks", "path": PLACEMENT, "field": "placement.title",
                                           "service": sonar, "value": "SonarQube · Code quality",
                                           "baseMtime": MTIME})
say(code == 200 and doc.get("changed") is True and doc.get("previous") == "SonarQube", "200, changed", f"{code} {doc.get('error')}")
say("collector" in doc.get("appliedNote", "") and doc.get("applied") is False,
    "the answer says the collector applies it, not a recreate", doc.get("appliedNote", ""))
after = text(PLACEMENT)
diff = [i for i, (a, b) in enumerate(zip(before.splitlines(), after.splitlines())) if a != b]
say(len(before.splitlines()) == len(after.splitlines()) and len(diff) == 1, "exactly one line changed", str(diff))
say([ln for ln in after.splitlines() if ln.lstrip().startswith("#")] == comments_before,
    "every comment survives byte-identical")
say("title: SonarQube · Code quality" in after, "the value landed where the locator said")
log = open(AUDIT, encoding="utf-8").read().splitlines()
say(len(log) == 1 and "PATCHED" in log[0] and "placement.title" in log[0] and sonar in log[0],
    "one audit line naming the rule and the field", log[-1] if log else "-")
MTIME = doc.get("mtime")

print()
print("── refusals ─────────────────────────────────────────────────────────")
for value, why in (("bothy: core", "': '"), ("bothy #x", "' #'")):
    code, doc = call("POST", "/config/patch", {"root": "stacks", "path": PLACEMENT, "field": "placement.section",
                                               "service": "project:auth", "value": value, "baseMtime": MTIME})
    say(code == 403 and why in doc.get("error", ""), f"a value containing {why} is refused", f"{code}")
code, doc = call("POST", "/config/patch", {"root": "stacks", "path": PLACEMENT, "field": "placement.title",
                                           "service": "project:auth", "value": "Identity", "baseMtime": MTIME})
say(code == 404, "a key the rule does not have is 404 - adding one is a Files edit", f"{code} {doc.get('error')}")
code, doc = call("GET", "/config/fields?root=stacks&path=apps/bothy-collector/twins.yml")
say(code == 422 and "more than one rule" in doc.get("error", ""),
    "two rules with one match list: the whole file is refused", f"{code} {doc.get('error')}")
say(text(PLACEMENT) == after, "no refusal wrote a byte")

srv.shutdown()
print()
if bad:
    print(f"FAILED: {bad}")
    sys.exit(1)
print("placement_http: all passed")
