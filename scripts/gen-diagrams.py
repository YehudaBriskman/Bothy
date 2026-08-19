#!/usr/bin/env python3
"""Render docs/diagrams/*.mmd to docs/assets/diagrams/*.svg.

    python3 scripts/gen-diagrams.py          # everything that is stale
    python3 scripts/gen-diagrams.py --all    # everything, stale or not

WHY THE SOURCES ARE FILES AND NOT FENCES. Bothy's markdown reader (md.tsx) is a
hand-written parser that builds React ELEMENTS and never an HTML string - that is
the property that lets it render arbitrary repo content with no sanitiser. It
therefore cannot run mermaid, which wants innerHTML, and a ```mermaid fence
renders as what it literally is: a code block. Bothy's own architecture diagrams
were unreadable in Bothy's own docs viewer.

The route that DOES work is `![alt](something.svg)`, because the sandbox origin
already serves .svg inline and the portal's `img-src` already reaches it. An SVG
loaded through <img> is also a still image as far as the browser is concerned -
no script, no network - so this adds a picture without adding an attack surface.

So the fence moved out to a .mmd file, the doc carries the image, and this script
is the join. One source, one artefact, and scripts/checks/diagrams.sh proves they
have not drifted.

── the palette, and why it is neutral ──────────────────────────────────────────

AN <img>-LOADED SVG IS AN ISOLATED DOCUMENT. It cannot see the page's CSS custom
properties, so it cannot follow the theme, and `prefers-color-scheme` inside it is
actively wrong: Bothy resolves "System" that way, but an explicit theme choice
stamps `data-theme` on <html> and the SVG never learns about it. Someone reading
in Bothy Light on a dark-mode OS would get a dark diagram.

One file therefore has to be legible on every ground it can land on. GROUNDS
below is that list, and it is worth reading before assuming the extremes are the
hard part. `.md-img` paints `--surface-2`, so the ground in Bothy is never --bg:
it is #fafafa, #f7f8fa, #24283b, #17171a - and gruvbox's #3c3836, which is a
MID-TONE. On GitHub it is #ffffff or #0d1117.

THE CEILING IS ABOUT 3.3:1 FOR ANYTHING ON THE PAGE, and it is arithmetic rather
than a lack of trying. The grounds fall into two clusters by relative luminance -
0.004 … 0.045 (gruvbox is the top of that one) and 0.95 … 1.0 - so a single
colour should sit in the gap between them, where its two worst ratios are equal.
Solving (L+0.05)/0.095 = 1.0/(L+0.05) puts it at L = 0.258 and the ratio at
3.30:1. Nothing does better against BOTH clusters, so 4.5:1 for free-standing
text is unreachable here and is not claimed. `--contrast` prints the measurement.

What IS reachable is 4.5:1 everywhere the words are, by not leaving text
free-standing: anything drawn on an OPAQUE fill only has to contrast with that
fill, and this file chooses the fill. Node labels and edge labels sit on FILL and
read at 9.9:1. What is left on the page is connectors, outlines and group titles,
where the bar is 3:1 because they are graphics - INK clears that on every ground,
at 3.23 in its worst case against a theoretical best of 3.30.

The node's own visibility swaps ground by ground rather than relying on one
colour to do both jobs: on the dark grounds the FILL carries it (6.1 - 10.4), on
the light ones the FILL nearly vanishes (1.8) and the BORDER carries it instead
(4.6 - 4.8). Either way the shape reads.

── the rasteriser ─────────────────────────────────────────────────────────────

mermaid-cli through npx, driving the headless Chromium already cached under
~/.cache/ms-playwright. Same choice, for the same reason, as scripts/gen-icons.py:
`mmdc` is not installed, and this box has no rsvg-convert, inkscape, imagemagick
or cairosvg either - what it has is the browser the screenshot checks installed,
and it renders with the engine that will later display the result.

NOTHING IN CI RUNS THIS. A GitHub runner has no Playwright browser, so
scripts/checks/diagrams.sh compares a hash instead of re-rendering - see its
header. Regenerating is a local, deliberate act: `just diagrams`.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "docs/diagrams"
OUT_DIR = ROOT / "docs/assets/diagrams"

# The staleness marker, written into the SVG and read back by
# scripts/checks/diagrams.sh. An XML comment survives every SVG consumer -
# browsers ignore it, git diffs it, and it needs no sidecar file that could go
# missing on its own.
STAMP = "bothy-mermaid-sha256"

# ── the palette ─────────────────────────────────────────────────────────────
#
# Every number below is the WORST ratio across GROUNDS - not the average and not
# the extremes, because the extremes are the easy case here. `--contrast` prints
# the full table; the docstring above has the method and the ceiling.
INK = "#848b96"        # >= 3.23:1 on EVERY ground below - near the ceiling
FILL = "#b6bcc6"       # carries the shape on the dark grounds (6.1 - 10.4)
BORDER = "#6b7280"     # carries it on the light ones (4.6 - 4.8)
FILL_TEXT = "#0f1115"  # 9.90:1 on the fill, which is the only ground it has

THEME = {
    "theme": "base",
    "themeVariables": {
        # Transparent, so the diagram inherits whatever surface it lands on
        # rather than punching a light rectangle into a dark page.
        "background": "transparent",
        "mainBkg": FILL,
        "primaryColor": FILL,
        "primaryBorderColor": BORDER,
        "primaryTextColor": FILL_TEXT,
        "nodeTextColor": FILL_TEXT,
        "secondaryColor": FILL,
        "tertiaryColor": FILL,
        "lineColor": INK,
        "textColor": INK,
        # A subgraph is an OUTLINE, not a panel. A filled cluster would be a
        # large block of mid-tone that reads as glare on a dark theme and as a
        # smudge on a light one, and it would bury the nodes inside it.
        "clusterBkg": "transparent",
        "clusterBorder": INK,
        "titleColor": INK,
        # An edge label sits ON TOP OF the line it labels, so it needs an opaque
        # backing or the stroke runs through the words. Same fill as a node,
        # which is also what makes its text safe to set dark.
        "edgeLabelBackground": FILL,
        # SYSTEM FONTS ONLY. An <img>-loaded SVG cannot fetch a webfont (and the
        # portal's CSP would not let it), so a named family that is not installed
        # falls back and the text stops matching the box mermaid measured for it.
        # A generic stack keeps that fallback close to what was measured here.
        "fontFamily": 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", '
                      'Roboto, "Helvetica Neue", Arial, sans-serif',
        "fontSize": "15px",
    },
    # ONE OVERRIDE, and it is a correctness fix rather than taste. mermaid ships
    # `.edgeLabel rect { opacity: 0.5 }`, which is fine when the diagram sits on
    # a known page colour and wrong here: at 50% the connector runs visibly
    # through the words, and the label's dark text is no longer on the fill it
    # was chosen against but on a blend of the fill and whatever theme is
    # underneath - measured at 1.9:1 on Bothy Dark. Opaque restores the 9.9:1 the
    # palette above claims.
    "themeCSS": ".edgeLabel rect { opacity: 1; }",
    # htmlLabels: false is NOT a style preference - it is what makes the file
    # work at all. With HTML labels mermaid puts every caption in a
    # <foreignObject>, and a browser rendering an SVG through <img> treats it as
    # an image rather than a document: foreignObject is not rendered there. The
    # first render of these seven looked like empty boxes joined by arrows.
    # `false` emits real <text>/<tspan>, which an image context does draw.
    #
    # useMaxWidth: false makes mermaid write a real width/height onto the <svg>.
    # It matters here and nowhere else: an SVG whose width is `100%` has no
    # intrinsic size, and a browser gives an <img> with no intrinsic size the
    # 300x150 default - so every diagram would arrive thumbnail-sized. With real
    # dimensions, `.md-img { max-width: 100% }` scales it down to the measure.
    "htmlLabels": False,
    "flowchart": {"useMaxWidth": False, "padding": 18, "htmlLabels": False},
}


def chromium() -> pathlib.Path | None:
    """The newest Playwright Chromium on this box, or None.

    Identical selection to scripts/gen-icons.py, deliberately: two scripts that
    reach for the same cache should not disagree about which build they mean.
    """
    cache = pathlib.Path.home() / ".cache/ms-playwright"
    builds = sorted(cache.glob("chromium-*/chrome-linux64/chrome"),
                    key=lambda p: int(p.parent.parent.name.split("-")[1]))
    return builds[-1] if builds else None


def digest(text: str) -> str:
    """The hash the SVG records. Of the SOURCE TEXT, normalised for line endings.

    Not of the file bytes: a checkout with autocrlf would then report every
    diagram stale on a machine that had changed nothing.
    """
    return hashlib.sha256(text.replace("\r\n", "\n").encode("utf-8")).hexdigest()


def stamped(svg: str) -> str | None:
    """The hash recorded in an existing SVG, or None if it carries no stamp."""
    marker = f"<!-- {STAMP}: "
    at = svg.find(marker)
    if at == -1:
        return None
    end = svg.find(" -->", at)
    return svg[at + len(marker):end].strip() if end != -1 else None


# Every ground one of these SVGs can be drawn on. The first two are the range
# the palette was solved for; the rest are inside it and are listed so a future
# theme that widens the range shows up here as a number below the bar rather than
# as a diagram somebody squints at.
GROUNDS = [
    ("#ffffff", "Bothy Light --bg, catppuccin-latte paper, GitHub light"),
    ("#09090b", "Bothy Dark --bg - the darkest ground there is"),
    ("#fafafa", "Bothy Light --surface-2 - what .md-img actually paints"),
    ("#17171a", "Bothy Dark --surface-2"),
    ("#f7f8fa", "catppuccin-latte --surface-2"),
    ("#3c3836", "gruvbox --surface-2"),
    ("#24283b", "tokyo-night --surface-2"),
]


def _luminance(hex_colour: str) -> float:
    """WCAG 2.1 relative luminance."""
    h = hex_colour.lstrip("#")
    chans = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        chans.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = chans
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a: str, b: str) -> float:
    """WCAG contrast ratio between two opaque colours."""
    la, lb = _luminance(a), _luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def contrast_report() -> int:
    """Print the palette's measured contrast on every ground it can land on.

    `python3 scripts/gen-diagrams.py --contrast`

    Here rather than in a comment because a number in a comment is a claim and a
    number a command prints is a measurement. Changing a colour above and running
    this is the whole review.
    """
    print(f"{'ground':<10} {'INK ' + INK:>16} {'FILL ' + FILL:>16} "
          f"{'BORDER ' + BORDER:>18}   bar: text 4.5, graphics 3.0")
    for ground, why in GROUNDS:
        print(f"{ground:<10} {ratio(INK, ground):>16.2f} {ratio(FILL, ground):>16.2f} "
              f"{ratio(BORDER, ground):>18.2f}   {why}")
    print()
    print(f"label text {FILL_TEXT} on the node/edge fill {FILL}: "
          f"{ratio(FILL_TEXT, FILL):.2f}  - the only ground that text has")
    return 0


def main() -> int:
    if "--contrast" in sys.argv[1:]:
        return contrast_report()
    force = "--all" in sys.argv[1:]

    if not SRC_DIR.is_dir():
        print(f"no sources: {SRC_DIR} does not exist", file=sys.stderr)
        return 1
    sources = sorted(SRC_DIR.glob("*.mmd"))
    if not sources:
        print(f"no *.mmd under {SRC_DIR}", file=sys.stderr)
        return 1

    todo = []
    for src in sources:
        want = digest(src.read_text(encoding="utf-8"))
        out = OUT_DIR / f"{src.stem}.svg"
        have = stamped(out.read_text(encoding="utf-8")) if out.is_file() else None
        if force or have != want:
            todo.append((src, out, want))

    if not todo:
        print(f"up to date - {len(sources)} diagram(s), nothing to render")
        return 0

    chrome = chromium()
    if chrome is None:
        print("no chromium under ~/.cache/ms-playwright - run `npx playwright install chromium`",
              file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="bothy-diagrams-"))
    fails = 0
    try:
        cfg = tmp / "mermaid.json"
        cfg.write_text(json.dumps(THEME), encoding="utf-8")
        # --no-sandbox because the Chromium namespace sandbox does not come up
        # under WSL2 without extra kernel settings, and this process only ever
        # renders files already in this repo.
        pup = tmp / "puppeteer.json"
        pup.write_text(json.dumps({"args": ["--no-sandbox"]}), encoding="utf-8")

        for src, out, want in todo:
            raw = tmp / f"{src.stem}.svg"
            cmd = ["npx", "-y", "@mermaid-js/mermaid-cli@11",
                   "-i", str(src), "-o", str(raw),
                   "-c", str(cfg), "-p", str(pup), "-b", "transparent"]
            r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                               env={**os.environ, "PUPPETEER_EXECUTABLE_PATH": str(chrome)})
            if r.returncode != 0 or not raw.is_file():
                print(f"FAIL  {src.name}\n{(r.stderr or r.stdout).strip()[-800:]}",
                      file=sys.stderr)
                fails += 1
                continue
            svg = raw.read_text(encoding="utf-8")
            # The stamp goes AFTER the <svg …> open tag rather than before it: a
            # comment ahead of the root element is legal XML but some consumers
            # (and `file`) sniff the first bytes, and an SVG that no longer
            # starts with `<svg` is a needless thing to have to debug.
            cut = svg.index(">") + 1
            svg = f"{svg[:cut]}\n<!-- {STAMP}: {want} -->\n" \
                  f"<!-- generated by scripts/gen-diagrams.py from " \
                  f"docs/diagrams/{src.name} - do not edit -->{svg[cut:]}"
            out.write_text(svg, encoding="utf-8")
            print(f"ok    {out.relative_to(ROOT)}  ({len(svg) // 1024} KB)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if fails:
        print(f"\n{fails} diagram(s) failed to render", file=sys.stderr)
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
