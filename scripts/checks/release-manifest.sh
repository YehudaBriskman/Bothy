#!/usr/bin/env bash
# D34: the release publishes Bothy's own images by digest and carries a manifest.
# Pure local (no network, no docker). Three things, all of which have bitten or
# would bite silently:
#
#  1. COVERAGE. Every image this repo builds must be in the release's publish
#     list (the `images` job matrix in .github/workflows/release.yml), and the
#     publish list must name nothing that is not built. A new module with a
#     Dockerfile, or a new `build:` in a compose file, that nobody added to the
#     matrix would otherwise ship in no release and nobody would notice until
#     an installer on a box with no checkout could not find it. The three sets
#     compared: apps/*/Dockerfile, compose services with `build:`, the matrix.
#     Each matrix entry must also point at a Dockerfile that exists.
#  2. THE GENERATOR (scripts/gen-release-manifest.py), unit-tested on throwaway
#     fixtures: the contract's shape, third-party read from the compose pins,
#     dedup of the same image used twice, and a FAIL on any image that is not
#     pinned by digest or that is pinned to two different digests.
#  3. THE REAL COMPOSE FILES pass the generator: every third-party image in the
#     repo is pinned by digest right now. This is what stops a floating tag
#     returning, and what makes the manifest's third_party section complete.
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -I - <<'PY'
import glob, importlib.util, json, os, re, sys, tempfile

fails = []
def fail(msg): fails.append(msg)

# ---- 1. coverage ---------------------------------------------------------
dockerfiles = {p.split("/")[1] for p in glob.glob("apps/*/Dockerfile")}
others = [p for p in glob.glob("**/Dockerfile*", recursive=True)
          if "node_modules" not in p and ".claude" not in p
          and not re.fullmatch(r"apps/[^/]+/Dockerfile", p)]
for p in others:
    fail(f"{p}: a Dockerfile outside apps/<name>/Dockerfile - the publish list only knows apps/*/Dockerfile; "
         "extend this check and the release matrix deliberately")

built = set()   # compose services with `build:` -> their image name
for path in glob.glob("**/compose*.yml", recursive=True):
    if "node_modules" in path or ".claude" in path:
        continue
    svc = has_build = image = None
    def flush():
        if svc and has_build:
            m = re.match(r"([\w.-]+):\$\{BOTHY_IMAGE_TAG", image or "")
            if m: built.add(m.group(1))
            else: fail(f"{path}: service {svc} has build: but no `image: <name>:${{BOTHY_IMAGE_TAG...}}`")
    for line in open(path, encoding="utf-8"):
        m = re.match(r"^  ([\w.-]+):\s*$", line)
        if m:
            flush(); svc, has_build, image = m.group(1), False, None
        elif re.match(r"^    build:", line): has_build = True
        elif re.match(r"^    image:", line): image = line.split(":", 1)[1].strip()
    flush()

release = open(".github/workflows/release.yml", encoding="utf-8").read()
m = re.search(r"^  images:\n(.*?)(?=^  \w[\w-]*:\n|\Z)", release, re.S | re.M)
if not m:
    fail("release.yml has no `images:` job"); published = {}
else:
    published = dict(re.findall(r"^\s+- image:\s*(\S+)\n\s+dockerfile:\s*(\S+)", m.group(1), re.M))
    if not published:
        fail("release.yml `images` job has no matrix entries `- image:` + `dockerfile:`")
for name, df in published.items():
    if not os.path.isfile(df):
        fail(f"release.yml publishes {name} from {df}, which does not exist")
    if df != f"apps/{name}/Dockerfile":
        fail(f"release.yml publishes {name} from {df}: expected apps/{name}/Dockerfile")

for label, a, b in (("apps/*/Dockerfile", dockerfiles, set(published)),
                    ("compose build: services", built, set(published)),
                    ("compose build: services", built, dockerfiles)):
    for x in sorted(a - b): fail(f"{x}: in {label} but not in the other set it is compared with "
                                 f"({'the release publish list' if b == set(published) else 'apps/*/Dockerfile'})")
    for x in sorted(b - a): fail(f"{x}: expected by the other set but absent from {label}")

# ---- 2. the generator on fixtures ---------------------------------------
spec = importlib.util.spec_from_file_location("gen", "scripts/gen-release-manifest.py")
gen = importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)
A, B = "a" * 64, "b" * 64
SHA = "c" * 40
OWN = [f"bothy-web=ghcr.io/o/bothy-web@sha256:{A}", f"bothy-ops=ghcr.io/o/bothy-ops@sha256:{B}"]

def tree(files):
    d = tempfile.mkdtemp()
    for rel, text in files.items():
        p = os.path.join(d, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w").write(text)
    return d

ok = tree({
    "compose.yml": "services:\n  web:\n    image: bothy-web:${BOTHY_IMAGE_TAG:-latest}\n"
                   f"  db:\n    image: postgres:17.12@sha256:{A}\n"
                   f"  proxy:\n    image: quay.io/oauth2-proxy/oauth2-proxy:v7.15.6@sha256:{B}   # why\n",
    "sub/compose.extra.yml": f"services:\n  x:\n    image: postgres:17.12@sha256:{A}\n",
    "node_modules/compose.yml": "services:\n  y:\n    image: floating:latest\n",
})
m = gen.build("2026.11.1", SHA, OWN, ok, ["linux/amd64", "linux/arm64"])
want = {
    "schema": 1, "version": "2026.11.1", "commit": SHA,
    "images": {"bothy-ops": {"ref": f"ghcr.io/o/bothy-ops@sha256:{B}", "platforms": ["linux/amd64", "linux/arm64"]},
               "bothy-web": {"ref": f"ghcr.io/o/bothy-web@sha256:{A}", "platforms": ["linux/amd64", "linux/arm64"]}},
    "assets": {"cli": "checksums.txt"},
}
for k, v in want.items():
    if m.get(k) != v: fail(f"generator: {k} = {m.get(k)!r}, want {v!r}")
tp = m["third_party"]
if sorted(tp) != ["oauth2-proxy", "postgres"]:
    fail(f"generator: third_party keys {sorted(tp)} (own image or node_modules leaked, or one missing)")
elif tp["postgres"]["ref"] != f"postgres@sha256:{A}" or tp["postgres"]["pinned_in"] != ["compose.yml", "sub/compose.extra.yml"]:
    fail(f"generator: postgres entry wrong: {tp['postgres']}")
if gen.main(["--version", "2026.11.1", "--commit", SHA, "--root", ok, "--own", OWN[0],
             "--out", os.path.join(ok, "out.json")]) != 0 or \
   json.load(open(os.path.join(ok, "out.json")))["schema"] != 1:
    fail("generator: CLI did not write a manifest")

def must_fail(why, **kw):
    args = dict(version="2026.11.1", commit=SHA, own=OWN, root=ok, platforms=["linux/amd64"]); args.update(kw)
    try: gen.build(**args)
    except gen.Fail: return
    fail(f"generator accepted {why}")

must_fail("a floating third-party tag", root=tree({"compose.yml": "services:\n  g:\n    image: grafana/grafana:13.3.1\n"}))
must_fail("a tag-only image beside a pinned one", root=tree({"compose.yml": f"services:\n  g:\n    image: x/y:1@sha256:{A}\n  h:\n    image: x/y:2\n"}))
must_fail("one image pinned to two digests", root=tree({"compose.yml": f"services:\n  g:\n    image: x/y:1@sha256:{A}\n  h:\n    image: x/y:1@sha256:{B}\n"}))
must_fail("a short digest", root=tree({"compose.yml": "services:\n  g:\n    image: x/y:1@sha256:abc\n"}))
must_fail("an own image given by tag", own=["bothy-web=ghcr.io/o/bothy-web:2026.11.1"])
must_fail("no own images", own=[])
must_fail("a duplicate own image", own=[OWN[0], OWN[0]])
must_fail("a bad commit", commit="abc")
must_fail("a bad version", version="v2026.11.1")

# ---- 3. the repo's real compose files -----------------------------------
try:
    real = gen.third_party(".")
    if not real: fail("real compose files: no third-party images found at all (parser broke?)")
except gen.Fail as e:
    for line in str(e).splitlines(): fail("real compose: " + line)

if fails:
    print("FAIL  release manifest / publish list:")
    for f in fails: print("  " + f)
    sys.exit(1)
print(f"PASS  release publish list = {sorted(published)} (Dockerfiles, compose build: and release.yml agree); "
      f"generator tests pass; {len(real)} third-party images, all pinned by digest")
PY
