#!/usr/bin/env python3
"""What is newer than what this box runs - discovered ON THE HOST, read-only.

    python3 apps/bothy-ops/discover_updates.py             discover, write, print a table
    python3 apps/bothy-ops/discover_updates.py --json      also print the document
    python3 apps/bothy-ops/discover_updates.py --state-dir DIR --textfile-dir DIR
                                                           write somewhere else (a trial run)
    just updates-discover                                  the first form, from the repo root

Build step 3 of docs/plans/updates.md. For every component in updates.toml it

  1. reads the PIN from the file the catalog names (a compose service's `image:`,
     a manifest container's `image:`, a shell variable, VERSION);
  2. reads what is RUNNING (`docker inspect`, `kubectl get`, `helm list` - all
     read-only, all allowed to fail: a missing cluster is a fact, not an error);
  3. asks upstream what is NEWER:
       images   the Docker Registry HTTP API v2 with an anonymous pull token
                (docker.io, ghcr.io, quay.io, gcr.io); tags/list, then a HEAD on
                the manifest for a digest. For docker.io the digest comes from
                Docker Hub's own tag API first, because Hub now counts even a HEAD
                against a 10-an-hour anonymous pull quota (hit 2026-09-18 while
                writing this) and the tag API does not.
       charts   the helm repository's index.yaml, scanned for one chart
       our code the GitHub releases of the repo (unauthenticated), against VERSION
  4. classifies each newer version patch / minor / major against the pin (only
     tags of the SAME SHAPE as the pin count - see updates.parse_version), and
     notes DRIFT: what runs is not what the files pin;
  5. writes ~/.local/state/bothy/updates/available.json (mode 600, atomically)
     and a node-exporter textfile, bothy_update_available{component,level}.

It changes nothing: no pull, no pin edit, no restart. The updater (step 4) is a
separate program that will read what this writes.

── rate limits ──────────────────────────────────────────────────────────────

Every answer is cached in ~/.cache/bothy/updates.json: tag lists and floating
tags for 5 hours (so the 6-hourly timer refreshes each run while a hand rerun
does not), a version tag's digest for a week (it does not move; when it does,
that is drift and worth a fresh look anyway), the helm index by ETag. A 429 stops
all further calls to that host for the rest of the run, and the stale cached
answer is used where there is one - said so in the component's `error`.

Standard library only, like inventory.py; runs under the system python3, from
host/systemd/bothy-updates-discover.timer or by hand.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

import updates  # noqa: E402  (the catalog parser bothy-ops uses - one definition of valid)

DOC_VERSION = 1
UA = "bothy-updates-discover/1 (+https://github.com/YehudaBriskman/Bothy)"
TIMEOUT = 20
MAX_BODY = 16 * 1024 * 1024           # the prometheus-community index is ~6.4 MB
MAX_TAG_PAGES = 50
MAX_DIGESTS_PER_COMPONENT = 12
KUBE_CONTEXT = os.environ.get("KUBE_CONTEXT", "thales-scc")

TTL_TAGS = 5 * 3600
TTL_FLOAT = 5 * 3600
TTL_DIGEST = 7 * 86400
TTL_INDEX = 5 * 3600

# The public registries this reads, and the host that serves each one's API.
REGISTRIES = {
    "docker.io": "https://registry-1.docker.io",
    "ghcr.io": "https://ghcr.io",
    "quay.io": "https://quay.io",
    "gcr.io": "https://gcr.io",
}
HUB_API = "https://hub.docker.com"
GITHUB_API = "https://api.github.com"

MANIFEST_ACCEPT = ", ".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))
_DIGEST = re.compile(r"sha256:[a-f0-9]{64}")


def _iso(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if ts is None else ts))


# ══ reading pins out of files (no YAML library: the host python may not have one) ══

def _strip(v: str) -> str:
    v = re.sub(r"\s+#.*$", "", v).strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    return v


def compose_service(text: str, service: str) -> dict[str, str]:
    """`image` and `container_name` of one service in a compose file.

    Indentation-scanned, in this repo's two-space style: `services:` at column 0,
    the service at 2, its keys at 4. Enough for the files this repo writes, and
    wrong loudly (nothing found) rather than quietly for anything else.
    """
    out: dict[str, str] = {}
    lines = text.splitlines()
    in_services = False
    in_svc = False
    for ln in lines:
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        indent = len(ln) - len(ln.lstrip(" "))
        if indent == 0:
            in_services = ln.rstrip() == "services:" or ln.startswith("services:")
            in_svc = False
            continue
        if not in_services:
            continue
        if indent == 2:
            in_svc = re.fullmatch(rf"{re.escape(service)}:\s*(#.*)?", ln.strip()) is not None
            continue
        if in_svc and indent == 4:
            m = re.fullmatch(r"(image|container_name):\s*(.+)", ln.strip())
            if m:
                out[m.group(1)] = _strip(m.group(2))
    return out


def manifest_image(text: str, container: str) -> str | None:
    """The `image:` of the container named `container` in a k8s manifest."""
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        m = re.fullmatch(r"(\s*)-\s+name:\s*(\S+)\s*", ln)
        if not m or _strip(m.group(2)) != container:
            continue
        key_indent = len(m.group(1)) + 2
        for nxt in lines[i + 1:]:
            if not nxt.strip() or nxt.lstrip().startswith("#"):
                continue
            ind = len(nxt) - len(nxt.lstrip(" "))
            if ind < key_indent or (ind == key_indent - 2 and nxt.lstrip().startswith("-")):
                break
            mm = re.fullmatch(r"\s*image:\s*(.+)", nxt)
            if mm and ind == key_indent:
                return _strip(mm.group(1))
    return None


def shell_var(text: str, var: str) -> str | None:
    m = re.search(rf"^{re.escape(var)}=(\S+)", text, re.M)
    return _strip(m.group(1)) if m else None


def split_image(ref: str) -> dict:
    """docker.io/library/x:tag@sha256:... -> {registry, repository, tag, digest, ref}."""
    rest, _, digest = ref.partition("@")
    first = rest.split("/", 1)[0]
    if "/" in rest and ("." in first or ":" in first or first == "localhost"):
        registry, path = rest.split("/", 1)
    else:
        registry, path = "docker.io", rest
    name, _, tag = path.rpartition(":") if ":" in path.rsplit("/", 1)[-1] else (path, "", "")
    if registry == "docker.io" and "/" not in name:
        name = f"library/{name}"
    return {"registry": registry, "repository": name, "tag": tag or None,
            "digest": digest if _DIGEST.fullmatch(digest or "") else None,
            "ref": f"{registry}/{name}"}


def same_image(a: str, b: str) -> bool:
    """Two spellings of one reference: `grafana/grafana:1` == `docker.io/grafana/grafana:1`."""
    x, y = split_image(a), split_image(b)
    return (x["ref"], x["tag"], x["digest"]) == (y["ref"], y["tag"], y["digest"])


# ══ the network: one client, with a cache and a 429 fuse ═════════════════════

class RateLimited(Exception):
    pass


class Net:
    def __init__(self, cache: dict, *, registries: dict | None = None, hub: str | None = HUB_API,
                 github: str = GITHUB_API, use_cache: bool = True) -> None:
        self.cache = cache
        self.registries = registries or REGISTRIES
        self.hub = hub
        self.github = github
        self.use_cache = use_cache
        self.tokens: dict[str, str] = {}
        self.blocked: set[str] = set()
        self.last: dict[str, float] = {}
        self.calls = 0

    # ── plumbing ──
    def _space(self, host: str) -> None:
        # Politeness, not correctness: a few requests a second at most per host.
        gap = time.monotonic() - self.last.get(host, 0)
        if gap < 0.2:
            time.sleep(0.2 - gap)
        self.last[host] = time.monotonic()

    def request(self, url: str, *, method: str = "GET", headers: dict | None = None,
                limit: int = MAX_BODY) -> tuple[int, dict, bytes]:
        host = urllib.parse.urlsplit(url).netloc
        if host in self.blocked:
            raise RateLimited(f"{host} rate-limited earlier in this run")
        self._space(host)
        self.calls += 1
        req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                body = r.read(limit + 1) if method != "HEAD" else b""
                if len(body) > limit:
                    raise OSError(f"{host} answered more than {limit} bytes")
                return r.status, {k.lower(): v for k, v in r.headers.items()}, body
        except urllib.error.HTTPError as e:
            hdrs = {k.lower(): v for k, v in (e.headers or {}).items()}
            if e.code == 429 or (e.code == 403 and hdrs.get("x-ratelimit-remaining") == "0"):
                self.blocked.add(host)
                raise RateLimited(f"{host} answered {e.code} (rate limit); no more calls to it this run") from None
            return e.code, hdrs, e.read(64 * 1024) if method != "HEAD" else b""

    def _cached(self, kind: str, key: str, ttl: float) -> object | None:
        ent = self.cache.get(kind, {}).get(key)
        if self.use_cache and isinstance(ent, dict) and time.time() - ent.get("at", 0) < ttl:
            return ent.get("v")
        return None

    def _stale(self, kind: str, key: str) -> object | None:
        ent = self.cache.get(kind, {}).get(key)
        return ent.get("v") if isinstance(ent, dict) else None

    def _put(self, kind: str, key: str, v: object) -> None:
        self.cache.setdefault(kind, {})[key] = {"at": time.time(), "v": v}

    # ── registry v2 ──
    def _auth(self, registry: str, repo: str, www: str) -> str | None:
        """An anonymous pull token from the realm a 401 named. Never a credential."""
        if not www.lower().startswith("bearer "):
            return None
        p = dict(re.findall(r'(\w+)="([^"]*)"', www))
        if "realm" not in p:
            return None
        q = {"scope": f"repository:{repo}:pull"}
        if p.get("service"):
            q["service"] = p["service"]
        st, _, body = self.request(f"{p['realm']}?{urllib.parse.urlencode(q)}")
        if st != 200:
            return None
        j = json.loads(body)
        return j.get("token") or j.get("access_token")

    def _v2(self, registry: str, repo: str, path: str, *, method: str = "GET",
            accept: str | None = None) -> tuple[int, dict, bytes]:
        base = self.registries.get(registry)
        if not base:
            raise ValueError(f"registry {registry} is not one this reads ({', '.join(self.registries)})")
        url = path if path.startswith("http") else f"{base}{path}"
        key = f"{registry}/{repo}"
        for _ in range(2):
            h = {"Accept": accept} if accept else {}
            if key in self.tokens:
                h["Authorization"] = f"Bearer {self.tokens[key]}"
            st, hdrs, body = self.request(url, method=method, headers=h)
            if st == 401 and key not in self.tokens:
                tok = self._auth(registry, repo, hdrs.get("www-authenticate", ""))
                if not tok:
                    return st, hdrs, body
                self.tokens[key] = tok
                continue
            return st, hdrs, body
        return st, hdrs, body

    def tags(self, registry: str, repo: str) -> list[str]:
        key = f"{registry}/{repo}"
        hit = self._cached("tags", key, TTL_TAGS)
        if hit is not None:
            return list(hit)
        try:
            out: list[str] = []
            url = f"/v2/{repo}/tags/list?n=1000"
            for _ in range(MAX_TAG_PAGES):
                st, hdrs, body = self._v2(registry, repo, url)
                if st != 200:
                    raise OSError(f"{registry} answered {st} listing {repo}'s tags")
                out += [t for t in (json.loads(body).get("tags") or []) if isinstance(t, str)]
                m = re.search(r'<([^>]+)>;\s*rel="?next"?', hdrs.get("link", ""))
                if not m:
                    break
                url = m.group(1)  # absolute, or a path _v2() puts on the registry's base
        except RateLimited:
            stale = self._stale("tags", key)
            if stale is None:
                raise
            return list(stale)
        self._put("tags", key, out)
        return out

    def digest(self, registry: str, repo: str, tag: str, *, floating: bool = False) -> tuple[str | None, str | None]:
        """(digest, publishedAt) of a tag - the index digest, the one `docker pull` records."""
        key = f"{registry}/{repo}:{tag}"
        hit = self._cached("digests", key, TTL_FLOAT if floating else TTL_DIGEST)
        if hit is not None:
            return tuple(hit)  # type: ignore[return-value]
        try:
            got: tuple[str | None, str | None] = (None, None)
            if registry == "docker.io" and self.hub:
                ns, name = repo.split("/", 1)
                st, _, body = self.request(f"{self.hub}/v2/namespaces/{ns}/repositories/{name}/tags/"
                                           f"{urllib.parse.quote(tag)}")
                if st == 200:
                    j = json.loads(body)
                    d = j.get("digest")
                    got = (d if isinstance(d, str) and _DIGEST.fullmatch(d) else None,
                           j.get("tag_last_pushed") or j.get("last_updated"))
            if not got[0]:
                st, hdrs, _ = self._v2(registry, repo, f"/v2/{repo}/manifests/{urllib.parse.quote(tag)}",
                                       method="HEAD", accept=MANIFEST_ACCEPT)
                d = hdrs.get("docker-content-digest")
                if st == 200 and d and _DIGEST.fullmatch(d):
                    got = (d, got[1])
                elif st == 200:
                    # A registry that omits the header: the digest IS the hash of
                    # the manifest bytes, so fetch them and compute it.
                    st, hdrs, body = self._v2(registry, repo, f"/v2/{repo}/manifests/{urllib.parse.quote(tag)}",
                                              accept=MANIFEST_ACCEPT)
                    if st == 200:
                        got = ("sha256:" + hashlib.sha256(body).hexdigest(), got[1])
        except RateLimited:
            stale = self._stale("digests", key)
            if stale is None:
                raise
            return tuple(stale)  # type: ignore[return-value]
        if got[0]:
            self._put("digests", key, list(got))
        return got

    # ── helm ──
    def chart_versions(self, repo_url: str, chart: str) -> list[dict]:
        key = f"{repo_url}#{chart}"
        hit = self._cached("charts", key, TTL_INDEX)
        if hit is not None:
            return list(hit)
        etags = self.cache.setdefault("etags", {})
        h = {"If-None-Match": etags[key]} if key in etags and self._stale("charts", key) is not None else {}
        try:
            st, hdrs, body = self.request(f"{repo_url}/index.yaml", headers=h)
        except RateLimited:
            stale = self._stale("charts", key)
            if stale is None:
                raise
            return list(stale)
        if st == 304:
            out = self._stale("charts", key) or []
        elif st == 200:
            out = helm_index_versions(body.decode("utf-8", "replace"), chart)
            if hdrs.get("etag"):
                etags[key] = hdrs["etag"]
        else:
            raise OSError(f"the helm index answered {st}")
        self._put("charts", key, out)
        return list(out)

    # ── github ──
    def releases(self, repo: str) -> list[dict]:
        hit = self._cached("github", repo, TTL_TAGS)
        if hit is not None:
            return list(hit)
        h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        try:
            st, _, body = self.request(f"{self.github}/repos/{repo}/releases?per_page=30", headers=h)
            if st != 200:
                raise OSError(f"GitHub answered {st} for {repo}'s releases")
            out = [{"tag": r["tag_name"], "publishedAt": r.get("published_at")}
                   for r in json.loads(body)
                   if isinstance(r, dict) and isinstance(r.get("tag_name"), str)
                   and not r.get("draft") and not r.get("prerelease")]
        except RateLimited:
            stale = self._stale("github", repo)
            if stale is None:
                raise
            return list(stale)
        self._put("github", repo, out)
        return out


def helm_index_versions(text: str, chart: str) -> list[dict]:
    """[{version, appVersion, created}] of one chart, scanned out of an index.yaml.

    The index is `entries:` -> `  <chart>:` -> a list of `  - ` items whose keys sit
    at four spaces. Line-scanned rather than parsed: the host python has no YAML
    library to rely on, and this is the only shape a helm repository writes.
    """
    out: list[dict] = []
    inside = False
    cur: dict | None = None
    for ln in text.splitlines():
        if not inside:
            if ln.rstrip() == f"  {chart}:":
                inside = True
            continue
        if ln.startswith("  - ") or ln.rstrip() == "  -":
            if cur:
                out.append(cur)
            cur = {}
            ln = "    " + ln[4:]
        elif ln and not ln.startswith("    ") and not ln.startswith("  -"):
            break  # the next chart, or the end of `entries:`
        m = re.fullmatch(r"    (version|appVersion|created|deprecated):\s*(.*)", ln.rstrip())
        if m and cur is not None:
            cur[m.group(1)] = _strip(m.group(2))
    if cur:
        out.append(cur)
    return [c for c in out if c.get("version") and c.get("deprecated") != "true"]


# ══ what is running (read-only, allowed to fail) ══════════════════════════════

def _run(argv: list[str], timeout: int = 15) -> str | None:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return p.stdout if p.returncode == 0 else None


def docker_running(container: str) -> dict | None:
    """{name, image, digest, state} of a container, or None when there is none."""
    out = _run(["docker", "inspect", "--type", "container", container])
    if not out:
        return None
    try:
        c = json.loads(out)[0]
    except (ValueError, IndexError, KeyError):
        return None
    image = (c.get("Config") or {}).get("Image")
    iid = c.get("Image")
    digest = None
    img_out = _run(["docker", "image", "inspect", iid]) if iid else None
    if img_out and image:
        try:
            rds = json.loads(img_out)[0].get("RepoDigests") or []
        except (ValueError, IndexError):
            rds = []
        want = split_image(image)["ref"]
        for rd in rds:
            if split_image(rd)["ref"] == want and split_image(rd)["digest"]:
                digest = split_image(rd)["digest"]
                break
    return {"name": container, "image": image, "digest": digest,
            "state": (c.get("State") or {}).get("Status")}


def kube_workload_images(workload: str) -> list[str] | None:
    ns, kind, name = workload.split("/")
    out = _run(["kubectl", "--context", KUBE_CONTEXT, "-n", ns, "get", kind, name, "-o", "json"], timeout=10)
    if not out:
        return None
    try:
        spec = json.loads(out)["spec"]["template"]["spec"]
    except (ValueError, KeyError):
        return None
    return [c.get("image") for c in spec.get("containers", []) if isinstance(c, dict)]


def helm_release_version(release: str, chart: str) -> str | None:
    ns, name = release.split("/")
    out = _run(["helm", "--kube-context", KUBE_CONTEXT, "-n", ns, "list", "-o", "json",
                "--filter", f"^{re.escape(name)}$"], timeout=10)
    if not out:
        return None
    try:
        for r in json.loads(out):
            if r.get("name") == name and str(r.get("chart", "")).startswith(chart + "-"):
                return str(r["chart"])[len(chart) + 1:]
    except (ValueError, TypeError):
        return None
    return None


# ══ classification ════════════════════════════════════════════════════════════

def candidates(current: updates.Version, tags: list[str]) -> dict[str, dict]:
    """The newest tag at each level above `current`, of the pin's shape."""
    best: dict[str, tuple[updates.Version, str]] = {}
    for t in tags:
        v = updates.parse_version(t)
        if not v:
            continue
        lv = updates.classify(current, v)
        if lv and (lv not in best or (v.parts, v.rev) > (best[lv][0].parts, best[lv][0].rev)):
            best[lv] = (v, t)
    return {lv: {"tag": t, "version": v.text, "level": lv} for lv, (v, t) in best.items()}


def latest_of(cands: dict[str, dict]) -> dict | None:
    for lv in ("major", "minor", "patch"):
        if lv in cands:
            return cands[lv]
    return None


# ══ one component ═════════════════════════════════════════════════════════════

class Discoverer:
    def __init__(self, catalog: updates.Catalog, net: Net, *, repo: str = REPO,
                 running: Callable[[str], dict | None] = docker_running,
                 kube: Callable[[str], list[str] | None] = kube_workload_images,
                 helm: Callable[[str, str], str | None] = helm_release_version) -> None:
        self.catalog = catalog
        self.net = net
        self.repo = repo
        self.running = running
        self.kube = kube
        self.helm = helm

    def _read(self, rel: str) -> str:
        with open(os.path.join(self.repo, rel), encoding="utf-8") as fh:
            return fh.read()

    def run(self, only: set[str] | None = None) -> dict:
        t0 = time.monotonic()
        comps = {}
        for c in self.catalog.components.values():
            if only and c.id not in only:
                continue
            fn = {"image": self.image, "manifest": self.image, "helm": self.chart,
                  "github": self.github}[c.source]
            entry = {"checkedAt": _iso(), "source": c.source, "error": None, "drift": None,
                     "current": {}, "running": [], "latest": None, "candidates": {}}
            try:
                fn(c, entry)
            except RateLimited as e:
                entry["error"] = str(e)
            except (OSError, ValueError, KeyError) as e:
                entry["error"] = f"{type(e).__name__}: {e}"[:300]
            comps[c.id] = entry
        return {"version": DOC_VERSION, "generatedAt": _iso(),
                "durationMs": int((time.monotonic() - t0) * 1000), "calls": self.net.calls,
                "components": comps}

    # ── images (compose services and manifest containers) ──
    def image(self, c: updates.Component, e: dict) -> None:
        refs = []
        for i in range(len(c.pins)):
            f, name = c.pin_parts(i)
            text = self._read(f)
            if c.source == "manifest":
                ref, cname = manifest_image(text, name), None
            else:
                svc = compose_service(text, name)
                ref, cname = svc.get("image"), svc.get("container_name")
            if not ref:
                raise ValueError(f"no image found for {c.pins[i]}")
            refs.append((c.pins[i], ref, cname))
        pinned = refs[0][1]
        disagree = [p for p, r, _ in refs[1:] if not same_image(r, pinned)]
        im = split_image(pinned)
        e["image"] = im["ref"]
        cur = updates.parse_version(im["tag"]) if im["tag"] else None
        e["current"] = {"tag": im["tag"], "version": cur.text if cur else None, "digest": im["digest"],
                        "float": bool(cur and len(cur.parts) < 3)}
        drift: list[str] = []
        if disagree:
            drift.append(f"{', '.join(disagree)} pin a different image than {refs[0][0]}")

        # What runs, and whether it is what the files say.
        if c.source == "manifest":
            imgs = self.kube(c.workload or "")
            if imgs is None:
                e["notes"] = ["the cluster did not answer - running version unknown"]
            else:
                e["running"] = [{"name": c.workload, "image": i, "digest": None, "state": "applied"} for i in imgs]
                if not any(i and same_image(i, pinned) for i in imgs):
                    drift.append(f"the cluster runs {', '.join(map(str, imgs))}, the manifest pins {pinned}")
        else:
            for pin, ref, cname in refs:
                if not cname:
                    continue
                r = self.running(cname)
                if r is None:
                    continue
                e["running"].append(r)
                if r.get("image") and not same_image(r["image"], ref):
                    drift.append(f"{cname} runs {r['image']}, {pin.split(':')[0]} pins {ref}")
                elif im["digest"] and r.get("digest") and r["digest"] != im["digest"]:
                    drift.append(f"{cname} runs {r['digest'][:19]}…, the pin is {im['digest'][:19]}…")

        budget = [MAX_DIGESTS_PER_COMPONENT]
        d: str | None = None

        def dig(tag: str, floating: bool = False) -> tuple[str | None, str | None]:
            if budget[0] <= 0:
                return (None, None)
            budget[0] -= 1
            return self.net.digest(im["registry"], im["repository"], tag, floating=floating)

        tags = self.net.tags(im["registry"], im["repository"])
        run_digests = {r["digest"] for r in e["running"] if r.get("digest")}

        if cur is None:
            # Pinned by digest alone: find which release it is among the newest.
            full = sorted((v, t) for t in tags if (v := updates.parse_version(t)) and len(v.parts) == 3)
            full = [p for p in full if p[0].shape == max(full)[0].shape] if full else []
            for v, t in reversed(full[-8:]):
                if dig(t)[0] == im["digest"]:
                    cur = v
                    e["current"].update(version=v.text, identifiedAs=t)
                    break
            if cur is None:
                raise ValueError("pinned by digest only, and the digest is none of the 8 newest releases")
        else:
            d, _ = dig(im["tag"], floating=e["current"]["float"])
            if e["current"]["float"]:
                # A floating pin (`v3.7`, `17`): newer releases arrive under the
                # same tag. That is an update waiting, not drift.
                e["floatMoved"] = bool(d and run_digests and d not in run_digests)
                fam = sorted((v, t) for t in tags if (v := updates.parse_version(t)) and len(v.parts) == 3
                             and v.prefix == cur.prefix and not v.has_rev and v.parts[:len(cur.parts)] == cur.parts)
                for v, t in reversed(fam[-5:]):
                    td, _ = dig(t)
                    if td and td in run_digests and "runningVersion" not in e:
                        e["runningVersion"] = v.text
                    if td and td == d and "floatTarget" not in e["current"]:
                        e["current"]["floatTarget"] = t
            elif d and run_digests and d not in run_digests and not drift:
                drift.append("the tag now names a different image than the one running "
                             "(re-published upstream, or pulled before a change)")

        cands = candidates(cur, tags)
        if e["current"]["float"] and e.get("floatMoved") and "patch" not in cands:
            # The float moved under the pin: surface it as the smallest step.
            tgt = e["current"].get("floatTarget")
            tv = updates.parse_version(tgt) if tgt else None
            cands["patch" if len(cur.parts) == 2 else "minor"] = {
                "tag": im["tag"], "version": tv.text if tv else None,
                "level": "patch" if len(cur.parts) == 2 else "minor", "floating": True}
        for cand in cands.values():
            if cand.get("floating"):
                cand["digest"] = d
                continue
            cand["digest"], cand["publishedAt"] = dig(cand["tag"])
        e["candidates"] = cands
        e["latest"] = latest_of(cands)
        e["drift"] = "; ".join(drift) or None

    # ── a helm chart ──
    def chart(self, c: updates.Component, e: dict) -> None:
        f, var = c.pin_parts()
        pin = shell_var(self._read(f), var or "")
        if not pin:
            raise ValueError(f"{var} not found in {f}")
        cur = updates.parse_version(pin)
        if not cur:
            raise ValueError(f"{var}={pin} is not a version")
        e["image"] = f"{c.chart_repo}#{c.chart}"
        e["current"] = {"tag": pin, "version": cur.text, "digest": None, "float": False}
        installed = self.helm(c.release or "", c.chart or "")
        if installed is None:
            e["notes"] = ["the cluster did not answer - installed chart unknown"]
        else:
            e["running"] = [{"name": c.release, "image": f"{c.chart}-{installed}", "digest": None, "state": "deployed"}]
            e["runningVersion"] = installed
            if installed != pin:
                e["drift"] = f"{c.release} has chart {installed} installed, {f} pins {pin}"
        vers = self.net.chart_versions(c.chart_repo or "", c.chart or "")
        cands = candidates(cur, [v["version"] for v in vers])
        created = {v["version"]: v.get("created") for v in vers}
        app = {v["version"]: v.get("appVersion") for v in vers}
        for cand in cands.values():
            cand["digest"] = None
            cand["publishedAt"] = created.get(cand["tag"])
            if app.get(cand["tag"]):
                cand["appVersion"] = app[cand["tag"]]
        e["candidates"] = cands
        e["latest"] = latest_of(cands)

    # ── our own code ──
    def github(self, c: updates.Component, e: dict) -> None:
        f, _ = c.pin_parts()
        pin = self._read(f).strip()
        cur = updates.parse_version("v" + pin)
        if not cur:
            raise ValueError(f"{f} holds {pin!r}, not a version")
        e["image"] = f"github.com/{c.repo}"
        e["current"] = {"tag": f"v{pin}", "version": cur.text, "digest": None, "float": False}
        rels = self.net.releases(c.repo or "")
        when = {r["tag"]: r.get("publishedAt") for r in rels}
        cands = candidates(cur, [r["tag"] for r in rels])
        for cand in cands.values():
            cand["digest"] = None
            cand["publishedAt"] = when.get(cand["tag"])
        e["candidates"] = cands
        e["latest"] = latest_of(cands)


# ══ writing ═══════════════════════════════════════════════════════════════════

def _atomic(path: str, data: str, mode: int, dir_mode: int) -> None:
    d = os.path.dirname(path)
    os.makedirs(d, mode=dir_mode, exist_ok=True)
    # A dot-prefixed temp name that does not end in .prom: node-exporter reads
    # only *.prom, so it can never scrape a half-written file.
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".bothy-updates.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def metrics(doc: dict) -> str:
    """The node-exporter textfile. Component ids are [a-z0-9-] (updates._ID), so
    they need no label escaping."""
    lines = [
        "# HELP bothy_update_available 1 for each step (patch, minor, major) at which a newer version of a component exists.",
        "# TYPE bothy_update_available gauge",
    ]
    comps = doc["components"]
    for cid in sorted(comps):
        for lv in ("patch", "minor", "major"):
            if lv in (comps[cid].get("candidates") or {}):
                lines.append(f'bothy_update_available{{component="{cid}",level="{lv}"}} 1')
    lines += ["# HELP bothy_update_drift 1 when what runs is not what the repository pins.",
              "# TYPE bothy_update_drift gauge"]
    lines += [f'bothy_update_drift{{component="{cid}"}} {1 if comps[cid].get("drift") else 0}' for cid in sorted(comps)]
    lines += ["# HELP bothy_update_check_error 1 when the last discovery could not check a component.",
              "# TYPE bothy_update_check_error gauge"]
    lines += [f'bothy_update_check_error{{component="{cid}"}} {1 if comps[cid].get("error") else 0}'
              for cid in sorted(comps)]
    lines += ["# HELP bothy_update_discover_last_run_timestamp_seconds When discover_updates.py last wrote.",
              "# TYPE bothy_update_discover_last_run_timestamp_seconds gauge",
              f"bothy_update_discover_last_run_timestamp_seconds {int(time.time())}"]
    return "\n".join(lines) + "\n"


def state_root() -> str:
    return os.environ.get("STATE_ROOT") or os.path.expanduser("~/.local/state")


def write(doc: dict, state_dir: str, textfile_dir: str | None) -> tuple[str, str | None]:
    """available.json mode 600 in a 700 directory; the textfile 644 in a 755 one -
    node-exporter runs as `nobody` and reads it through a read-only mount."""
    out = os.path.join(state_dir, "available.json")
    _atomic(out, json.dumps(doc, indent=1, sort_keys=True), 0o600, 0o700)
    prom = None
    if textfile_dir:
        prom = os.path.join(textfile_dir, "bothy_updates.prom")
        _atomic(prom, metrics(doc), 0o644, 0o755)
    return out, prom


def load_cache(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            c = json.load(fh)
        return c if isinstance(c, dict) else {}
    except (OSError, ValueError):
        return {}


def table(doc: dict, catalog: updates.Catalog) -> str:
    rows = [("component", "channel", "pinned", "available", "level", "drift / error")]
    for cid, c in catalog.components.items():
        e = doc["components"].get(cid)
        if not e:
            continue
        cur = e.get("current") or {}
        pinned = cur.get("tag") or (cur.get("identifiedAs") and f"@{cur['identifiedAs']}") or "?"
        lat = e.get("latest") or {}
        avail = lat.get("tag") or "-"
        if lat.get("floating"):
            avail = f"{avail} (moved{' to ' + cur['floatTarget'] if cur.get('floatTarget') else ''})"
        lv = lat.get("level") or ""
        note = e.get("error") or e.get("drift") or ""
        rows.append((cid, updates.effective_channel(c.channel, lat.get("level")) or c.channel, pinned, avail, lv,
                     note[:90]))
    w = [max(len(str(r[i])) for r in rows) for i in range(5)]
    return "\n".join("  ".join(str(r[i]).ljust(w[i]) for i in range(5)) + "  " + r[5] for r in rows)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Discover newer versions of what this box runs (read-only).")
    ap.add_argument("--state-dir", help="where available.json goes (default ~/.local/state/bothy/updates)")
    ap.add_argument("--textfile-dir", help="the node-exporter textfile directory (default ~/.local/state/bothy/textfile)")
    ap.add_argument("--no-textfile", action="store_true", help="do not write the metrics file")
    ap.add_argument("--cache", help="the registry answer cache (default ~/.cache/bothy/updates.json)")
    ap.add_argument("--no-cache", action="store_true", help="ask upstream again, ignoring cached answers")
    ap.add_argument("--only", help="comma-separated component ids")
    ap.add_argument("--json", action="store_true", help="print the document as well as the table")
    ap.add_argument("--quiet", action="store_true", help="no table (the timer)")
    a = ap.parse_args(argv)

    try:
        catalog = updates.load(os.path.join(HERE, "updates.toml"))
    except (updates.CatalogError, OSError, ValueError) as e:
        print(f"updates.toml is invalid - nothing discovered: {e}", file=sys.stderr)
        return 2
    only = set(a.only.split(",")) if a.only else None
    if only and only - set(catalog.components):
        print(f"unknown component(s): {', '.join(sorted(only - set(catalog.components)))}", file=sys.stderr)
        return 2
    state_dir = a.state_dir or os.path.join(state_root(), "bothy", "updates")
    textfile_dir = None if a.no_textfile else (a.textfile_dir or os.path.join(state_root(), "bothy", "textfile"))
    cache_path = a.cache or os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
                                         "bothy", "updates.json")
    cache = load_cache(cache_path)
    net = Net(cache, use_cache=not a.no_cache)
    doc = Discoverer(catalog, net).run(only)
    out, prom = write(doc, state_dir, textfile_dir)
    try:
        _atomic(cache_path, json.dumps(cache, separators=(",", ":")), 0o600, 0o700)
    except OSError as e:
        print(f"note: the cache could not be written ({e})", file=sys.stderr)
    if not a.quiet:
        print(table(doc, catalog))
    if a.json:
        print(json.dumps(doc, indent=1, sort_keys=True))
    comps = doc["components"].values()
    print(f"updates: {sum(1 for e in comps if e.get('latest'))} with a newer version, "
          f"{sum(1 for e in comps if e.get('drift'))} drifting, {sum(1 for e in comps if e.get('error'))} unchecked; "
          f"{doc['calls']} requests in {doc['durationMs']} ms -> {out}" + (f" + {prom}" if prom else ""),
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
