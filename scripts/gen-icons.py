#!/usr/bin/env python3
"""Rasterise the app icons from the two SVGs that define them.

    python3 scripts/gen-icons.py

THE POINT OF THIS FILE is that the geometry lives in exactly one place. Before
it, `favicon.svg` carried a comment saying "the same geometry as
scripts/gen-icons.py - if you change one, change both" and that script did not
exist; the PNGs beside it had been produced by something nobody recorded. A mark
maintained in two places drifts, and nothing in a build catches it, because no
test renders a favicon.

Sources, and why there are two:

  favicon.svg        A ROUNDED TILE. Used as-is for the browser tab, and
                     rasterised for icon-192/512 and apple-touch-icon.
  icon-maskable.svg  FULL BLEED, mark scaled to 0.72. Android applies its own
                     shape - circle, squircle, teardrop - and anything outside
                     the centred circle of 80% diameter is cut. Measured on the
                     old mark: its furthest vertex was the wall foot at radius
                     10.56 on a 24-unit grid, against a safe radius of 9.60, so
                     the hut's feet were being clipped on every Android launcher.

  apple-touch-icon   iOS IGNORES `purpose: maskable` and applies its own mask to
                     whatever it is given, so it takes the full-bleed art too -
                     otherwise the rounded tile is rounded a second time and the
                     icon sits visibly inset inside its own corners, which is
                     what the previous apple-touch-icon.png did.

RASTERISER. Headless Chromium through Playwright, which is already installed
here for the screenshot checks. That is a heavier dependency than rsvg-convert,
and it is the one this box actually has - none of rsvg-convert, inkscape,
imagemagick or cairosvg is present. It also renders the SVG with the same engine
that will render the favicon, so what is written is what a browser would draw.
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "apps/portal-next/web/public"

# (source svg, output png, pixel size). Sizes are the manifest's, plus the one
# Apple asks for.
JOBS = [
    ("favicon.svg", "icon-192.png", 192),
    ("favicon.svg", "icon-512.png", 512),
    ("icon-maskable.svg", "icon-maskable-512.png", 512),
    ("icon-maskable.svg", "apple-touch-icon.png", 180),
]


def main() -> int:
    """Render each source through headless Chromium.

    Via `npx playwright screenshot`, not the python package: this box has the
    former (it is what the screenshot checks already use) and not the latter.
    The wrapper page exists because a bare SVG loaded as a document is scaled by
    the browser to fit the viewport, which is not the same as drawing it at a
    size - and for an icon, the difference is a blurred edge.
    """
    import subprocess
    import tempfile

    # `npx playwright screenshot` insists on ITS pinned browser build and offers
    # to download one. This box already has several, installed for the MCP that
    # drives the screenshot checks, so use the newest of those rather than adding
    # another few hundred megabytes for pixels we render four of.
    cache = pathlib.Path.home() / ".cache/ms-playwright"
    builds = sorted(cache.glob("chromium-*/chrome-linux64/chrome"),
                    key=lambda p: int(p.parent.parent.name.split("-")[1]))
    if not builds:
        print("no chromium under ~/.cache/ms-playwright - run `npx playwright install chromium`",
              file=sys.stderr)
        return 1
    chrome = builds[-1]

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="bothy-icons-"))
    rc = 0
    for src, out, size in JOBS:
        svg = (PUBLIC / src).read_text()
        page = tmp / f"{out}.html"
        page.write_text(
            "<!doctype html><meta charset='utf-8'>"
            "<style>html,body{margin:0;padding:0;background:transparent}"
            f"svg{{display:block;width:{size}px;height:{size}px}}</style>{svg}"
        )
        # --headless=new so the shot matches what a current browser paints;
        # --force-device-scale-factor=1 so a HiDPI default cannot silently
        # double the output and leave a 384px file called icon-192.png.
        cmd = [
            str(chrome), "--headless=new", "--disable-gpu", "--no-sandbox",
            "--hide-scrollbars", "--default-background-color=00000000",
            "--force-device-scale-factor=1",
            f"--window-size={size},{size}",
            f"--screenshot={PUBLIC / out}",
            f"file://{page}",
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"  FAILED {src} -> {out}: {r.stderr.strip()[:200]}", file=sys.stderr)
            rc = 1
            continue
        print(f"  {src:22} -> {out:26} {size}x{size}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
