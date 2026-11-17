#!/usr/bin/env python3
"""Build release-manifest.json (D34): what an installer pulls, by digest.

    gen-release-manifest.py --version 2026.11.1 --commit <40hex> \
        --own bothy-web=ghcr.io/o/bothy-web@sha256:<64hex> [--own ...] \
        [--root DIR] [--platforms linux/amd64,linux/arm64] [--out FILE]

* images       the digests passed with --own (CI records them after the push).
* third_party  READ FROM THE COMPOSE FILES under --root: every `image:` line of
               every compose*.yml. The compose pins stay the single source of
               truth; nothing is written down twice. Images this repo builds
               (an `image:` containing `${BOTHY_IMAGE_TAG`) are not third party.
               Any other image not pinned `name[:tag]@sha256:<64hex>` is an
               ERROR (exit 1): a release must not describe an image it cannot
               name by digest.
* assets       {"cli": "checksums.txt"}, the name of the CLI checksums asset.

Pure local: stdlib only, no network, no docker.
"""
import argparse, json, os, re, sys

DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
VERSION = re.compile(r"^\d{4}\.\d+\.\d+$")
SHA = re.compile(r"^[0-9a-f]{40}$")
IMAGE_LINE = re.compile(r"^\s*image:\s*(?P<ref>[^\s#]+)")
SKIP_DIRS = {"node_modules", ".git", ".claude", "dist", "vendor"}


class Fail(Exception):
    pass


def compose_files(root):
    out = []
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        for f in sorted(files):
            if f.startswith("compose") and f.endswith((".yml", ".yaml")):
                out.append(os.path.join(d, f))
    return out


def split_ref(ref):
    """'host/a/b:tag@sha256:...' -> (repo, tag|None, digest|None)."""
    digest = None
    if "@" in ref:
        ref, digest = ref.split("@", 1)
    tag = None
    last = ref.rsplit("/", 1)[-1]
    if ":" in last:
        ref, tag = ref.rsplit(":", 1)
    return ref, tag, digest


def third_party(root):
    found, problems = {}, []
    for path in compose_files(root):
        rel = os.path.relpath(path, root)
        for n, line in enumerate(open(path, encoding="utf-8"), 1):
            m = IMAGE_LINE.match(line)
            if not m:
                continue
            ref = m.group("ref")
            if "${BOTHY_IMAGE_TAG" in ref:
                continue  # our own build, not third party
            repo, tag, digest = split_ref(ref)
            if not digest or not DIGEST.match(digest):
                problems.append(f"{rel}:{n}: {ref} is not pinned by sha256 digest")
                continue
            name = repo.rsplit("/", 1)[-1]
            entry = {"ref": f"{repo}@{digest}", "tag": tag, "pinned_in": [rel]}
            old = found.get(name)
            if old is None:
                found[name] = entry
            elif old["ref"] != entry["ref"]:
                problems.append(f"{rel}:{n}: {name} is pinned to two different digests "
                                f"({old['ref']} in {old['pinned_in'][0]}, {entry['ref']})")
            elif rel not in old["pinned_in"]:
                old["pinned_in"].append(rel)
    if problems:
        raise Fail("\n".join(problems))
    return {k: found[k] for k in sorted(found)}


def build(version, commit, own, root, platforms):
    if not VERSION.match(version):
        raise Fail(f"version {version!r} is not YYYY.M.N")
    if not SHA.match(commit):
        raise Fail(f"commit {commit!r} is not 40 hex")
    if not own:
        raise Fail("no own images given: a release with no images is not a release")
    images = {}
    for item in own:
        name, sep, ref = item.partition("=")
        repo, _, digest = split_ref(ref)
        if not sep or not name or not digest or not DIGEST.match(digest):
            raise Fail(f"--own {item!r}: want name=registry/repo@sha256:<64hex>")
        if name in images:
            raise Fail(f"--own {name} given twice")
        images[name] = {"ref": f"{repo}@{digest}", "platforms": list(platforms)}
    return {
        "schema": 1,
        "version": version,
        "commit": commit,
        "images": {k: images[k] for k in sorted(images)},
        "third_party": third_party(root),
        "assets": {"cli": "checksums.txt"},
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--version", required=True)
    ap.add_argument("--commit", required=True)
    ap.add_argument("--own", action="append", default=[], metavar="NAME=REF@DIGEST")
    ap.add_argument("--root", default=os.path.join(os.path.dirname(__file__), ".."))
    ap.add_argument("--platforms", default="linux/amd64,linux/arm64")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    try:
        m = build(a.version, a.commit, a.own, a.root, a.platforms.split(","))
    except Fail as e:
        print(f"gen-release-manifest: {e}", file=sys.stderr)
        return 1
    text = json.dumps(m, indent=2) + "\n"
    if a.out:
        open(a.out, "w", encoding="utf-8").write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
