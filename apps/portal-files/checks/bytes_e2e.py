#!/usr/bin/env python3
import io, os, re, sys, zipfile, tarfile, requests

BASE = "http://100.117.176.85"
SANDBOX = "http://100.117.176.85:8100"
fails = 0


def check(label, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(f"{'PASS' if ok else 'FAIL'}  {label:<54} {detail}")


s = requests.Session()
r = s.get(f"{BASE}/oauth2/start", params={"rd": "/"}, allow_redirects=True, timeout=10)
m = re.search(r'action="([^"]+)"', r.text)
s.post(m.group(1).replace("&amp;", "&"),
       data={"username": os.environ["DEV_LOGIN_USER"],
             "password": os.environ["DEV_LOGIN_PASSWORD"]},
       allow_redirects=True, timeout=10)

print("── /raw: real bytes ────────────────────────────────────────────────")
r = s.get(f"{SANDBOX}/-/api/files/raw",
          params={"root": "stacks", "path": "docs/assets/portal-overview.png"}, timeout=30)
check("a PNG is served inline as image/png",
      r.status_code == 200 and r.headers["Content-Type"] == "image/png"
      and "inline" in r.headers["Content-Disposition"])
check("the bytes are a REAL png (magic intact)",
      r.content[:8] == b"\x89PNG\r\n\x1a\n", f"{len(r.content)} bytes")
check("Content-Length matches the body", int(r.headers["Content-Length"]) == len(r.content))

r2 = s.get(f"{SANDBOX}/-/api/files/raw",
           params={"root": "stacks", "path": "docs/assets/portal-overview.png",
                   "download": "1"}, timeout=30)
check("?download=1 downgrades to attachment",
      "attachment" in r2.headers["Content-Disposition"]
      and r2.headers["Content-Type"] == "application/octet-stream")

print("\n── /raw: the guards still hold ─────────────────────────────────────")
for label, root, path, want in [
    ("a denied secret (.env)", "stacks", ".env", 403),
    ("a private key", "projects",
     "army/monorepo-inherited/apps/site-relay-app/cert/key.pem", 403),
    ("traversal", "stacks", "../../etc/passwd", 403),
    ("the repo .git", "stacks", ".git/config", 403),
    ("a directory, not a file", "stacks", "docs", 403),
]:
    rr = s.get(f"{SANDBOX}/-/api/files/raw", params={"root": root, "path": path}, timeout=15)
    check(label, rr.status_code == want, f"got {rr.status_code}")

print("\n── Range: implemented narrowly, and each refusal is its own path ───")
# Range was deliberately NOT implemented at first, and that was right while
# nothing inline needed it. Video changed the balance. Each case below is a
# separate branch of the parser, so each gets its own assertion - a single
# "ranges work" check would pass with three of them broken.
PNG = {"root": "stacks", "path": "docs/assets/portal-overview.png"}
full = s.get(f"{SANDBOX}/-/api/files/raw", params=PNG, timeout=30)
size = len(full.content)

r = s.get(f"{SANDBOX}/-/api/files/raw", params=PNG,
          headers={"Range": "bytes=0-99"}, timeout=30)
check("a first-N range returns 206", r.status_code == 206, f"got {r.status_code}")
check("...with exactly those bytes", len(r.content) == 100 and r.content == full.content[:100])
check("...and a correct Content-Range",
      r.headers.get("Content-Range") == f"bytes 0-99/{size}", r.headers.get("Content-Range"))

r = s.get(f"{SANDBOX}/-/api/files/raw", params=PNG,
          headers={"Range": "bytes=-100"}, timeout=30)
check("a SUFFIX range returns the LAST bytes",
      r.status_code == 206 and r.content == full.content[-100:], f"got {r.status_code}")

r = s.get(f"{SANDBOX}/-/api/files/raw", params=PNG,
          headers={"Range": f"bytes={size-50}-"}, timeout=30)
check("an open-ended range runs to EOF",
      r.status_code == 206 and r.content == full.content[-50:], f"got {r.status_code}")

for label, hdr in [("multi-range", "bytes=0-10,20-30"),
                   ("a non-byte unit", "items=0-9"),
                   ("garbage", "bytes=abc"),
                   ("a start past EOF", f"bytes={size+10}-"),
                   ("a reversed range", "bytes=50-10")]:
    rr = s.get(f"{SANDBOX}/-/api/files/raw", params=PNG,
               headers={"Range": hdr}, timeout=30)
    check(f"{label} is refused with 416", rr.status_code == 416, f"got {rr.status_code}")

print("\n── the new viewers ─────────────────────────────────────────────────")
# SVG and HTML are served INLINE now - on the sandbox origin only, which is what
# makes it safe. checks/sandbox_escape.mjs proves the containment; this only
# proves the content type is right.
import tempfile
probe = "/home/devssh/claude-notes/_viewer-probe.svg"
open(probe, "w").write('<svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>')
r = s.get(f"{SANDBOX}/-/api/files/raw",
          params={"root": "notes", "path": "_viewer-probe.svg"}, timeout=20)
check("an SVG is served inline as image/svg+xml",
      r.status_code == 200 and r.headers.get("Content-Type") == "image/svg+xml"
      and "inline" in r.headers.get("Content-Disposition", ""),
      f"{r.status_code} {r.headers.get('Content-Type')}")
check("...carrying the CSP that contains it",
      "sandbox" in (r.headers.get("Content-Security-Policy") or ""),
      r.headers.get("Content-Security-Policy"))
os.remove(probe)

print("\n── /archive: zip ───────────────────────────────────────────────────")
r = s.get(f"{SANDBOX}/-/api/files/archive",
          params={"root": "notes", "format": "zip"}, timeout=60)
check("notes archives as a zip", r.status_code == 200, f"got {r.status_code}")
if r.status_code == 200:
    check("entry/skip counts are reported in headers",
          "X-Files-Entries" in r.headers,
          f"{r.headers.get('X-Files-Entries')} entries, "
          f"{r.headers.get('X-Files-Skipped')} skipped")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    check("it is a valid zip that opens", len(names) > 0, f"{len(names)} entries")
    prefixes = {n.split("/")[0] for n in names}
    check("every entry sits under ONE top-level dir (no tarbomb)",
          len(prefixes) == 1, str(prefixes))
    check("no entry escapes with ..", not any(".." in n.split("/") for n in names))
    check("no entry is absolute", not any(n.startswith("/") for n in names))
    check("SKIPPED.txt is present and first",
          names[0].endswith("SKIPPED.txt"), names[0])
    check("no .env in the archive",
          not any(os.path.basename(n) == ".env" for n in names))
    check("no .git/ in the archive", not any("/.git/" in n for n in names))
    # content actually survives
    body = z.read([n for n in names if n.endswith("README.md")][0])
    check("a member's bytes are intact", len(body) > 100, f"README.md {len(body)} bytes")

print("\n── /archive: tar.gz ────────────────────────────────────────────────")
r = s.get(f"{SANDBOX}/-/api/files/archive",
          params={"root": "notes", "format": "tgz"}, timeout=60)
check("notes archives as tar.gz", r.status_code == 200, f"got {r.status_code}")
if r.status_code == 200:
    t = tarfile.open(fileobj=io.BytesIO(r.content), mode="r:gz")
    ms = t.getmembers()
    check("it is a valid tar that opens", len(ms) > 0, f"{len(ms)} entries")
    check("modes are forced to 0644, uid/gid 0",
          all(m.mode == 0o644 and m.uid == 0 and m.gid == 0 for m in ms))
    check("no symlink entries", not any(m.issym() or m.islnk() for m in ms))

print("\n── /archive: caps ──────────────────────────────────────────────────")
r = s.get(f"{SANDBOX}/-/api/files/archive",
          params={"root": "projects", "format": "zip"}, timeout=120)
check("the whole projects root is REFUSED by the entry cap",
      r.status_code == 413, f"got {r.status_code}")
if r.status_code == 413:
    check("and the refusal is actionable JSON, nothing streamed",
          "limit" in r.json(), str(r.json())[:90])

r = s.get(f"{SANDBOX}/-/api/files/archive",
          params={"root": "projects", "path": "army/Tals/auth", "format": "zip"}, timeout=60)
check("but a SUBTREE of projects archives fine",
      r.status_code == 200, f"got {r.status_code}")

print("\n── CSRF: the hole the sandbox origin opens ─────────────────────────")
# A text/plain POST is a CORS-"simple" request and skips the preflight entirely.
r = s.post(f"{BASE}/-/api/files/write",
           data='{"root":"notes","path":"csrf.md","content":"x"}',
           headers={"Content-Type": "text/plain"}, timeout=15)
check("a text/plain write is refused (no preflight = no protection)",
      r.status_code == 415, f"got {r.status_code}")
r = s.post(f"{BASE}/-/api/files/write",
           json={"root": "notes", "path": "csrf.md", "content": "x"},
           headers={"Sec-Fetch-Site": "cross-site"}, timeout=15)
check("a cross-site write is refused", r.status_code == 403, f"got {r.status_code}")
check("and neither left a file behind",
      not os.path.exists("/home/devssh/claude-notes/csrf.md"))

print("\n── anonymous ───────────────────────────────────────────────────────")
a = requests.Session()
for label, url, params in [
    ("raw", f"{SANDBOX}/-/api/files/raw", {"root": "stacks", "path": "README.md"}),
    ("archive", f"{SANDBOX}/-/api/files/archive", {"root": "notes"}),
]:
    rr = a.get(url, params=params, timeout=20)
    check(f"anonymous {label} is refused", rr.status_code == 401, f"got {rr.status_code}")

print(f"\n{fails} FAILED" if fails else "\nall pass")
sys.exit(1 if fails else 0)
