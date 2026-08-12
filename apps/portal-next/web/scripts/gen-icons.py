#!/usr/bin/env python3
"""Generate the Bothy app icons into web/public/.

WHY THIS EXISTS: an SVG favicon covers every current desktop browser, but iOS
home-screen icons (apple-touch-icon) and the PWA manifest still want PNG, and
this box has no rsvg-convert / ImageMagick / sharp. Rather than commit binary
blobs nobody can regenerate, the mark is defined once as geometry below and
rasterised here with the standard library only (zlib + struct).

The mark: a gabled shelter with the light on. A bothy is a small hut kept
unlocked for whoever needs it — which is what this box is — and the lit window
is the accent-coloured dot, i.e. "something is running in there".

Run:  python3 scripts/gen-icons.py
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public"

BG = (0x09, 0x09, 0x0B)      # --bg          zinc-950
INK = (0xFA, 0xFA, 0xFA)     # --fg
LIT = (0x60, 0xA5, 0xFA)     # --accent      blue-400

# Geometry in the same 24-unit space as the SVG favicon, so the two cannot drift.
#
# Squat and wide with a deep overhanging roof, so it reads as a shelter rather
# than as lucide's `House` — which is what the first attempt looked like, a
# generic home glyph with a dot on it.
ROOF = [(2.4, 11.6), (12.0, 4.2), (21.6, 11.6)]
BODY = [(5.6, 10.6), (5.6, 20.4), (18.4, 20.4), (18.4, 10.6)]
STROKE = 2.0
# The door, not a window: a bothy is the hut left unlocked for whoever needs it,
# so the mark is an open arched doorway with the light on (accent-coloured).
DOOR_X = (10.15, 13.85)
DOOR_TOP = 15.3      # centre of the arch
DOOR_BOTTOM = 20.4
DOOR_R = (DOOR_X[1] - DOOR_X[0]) / 2.0

SS = 4  # supersampling factor — the only antialiasing this needs


def dist_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    dx, dy = ax + t * vx - px, ay + t * vy - py
    return math.hypot(dx, dy)


def rounded_rect_sdf(px, py, half, radius):
    """Signed distance to a rounded square centred on the origin."""
    qx, qy = abs(px) - (half - radius), abs(py) - (half - radius)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    return outside + min(max(qx, qy), 0.0) - radius


def render(size, *, rounded=True, pad=0.0):
    """Return an RGB bytes buffer of `size`x`size`."""
    px_per_unit = size / 24.0
    half = size / 2.0
    radius = size * 0.225
    buf = bytearray(size * size * 3)

    for y in range(size):
        for x in range(size):
            r_acc = g_acc = b_acc = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    # sample centre, in device px then in 24-unit space
                    dx = x + (sx + 0.5) / SS
                    dy = y + (sy + 0.5) / SS
                    ux = dx / px_per_unit
                    uy = dy / px_per_unit
                    # 1 — the tile
                    if rounded:
                        d = rounded_rect_sdf(dx - half, dy - half, half, radius)
                        inside_tile = d <= 0
                    else:
                        inside_tile = True
                    if not inside_tile:
                        continue  # transparent-ish → leave as background below
                    col = BG
                    # 2 — the strokes, inset by `pad` units for the maskable icon
                    sw = STROKE / 2.0
                    hit = False
                    for a, b in zip(ROOF, ROOF[1:]):
                        if dist_to_segment(ux, uy, a[0], a[1], b[0], b[1]) <= sw:
                            hit = True
                            break
                    if not hit:
                        for a, b in zip(BODY, BODY[1:]):
                            if dist_to_segment(ux, uy, a[0], a[1], b[0], b[1]) <= sw:
                                hit = True
                                break
                    if hit:
                        col = INK
                    # 3 — the lit doorway, drawn last so it wins over the wall
                    in_jamb = DOOR_X[0] <= ux <= DOOR_X[1]
                    if (in_jamb and DOOR_TOP <= uy <= DOOR_BOTTOM) or (
                        math.hypot(ux - 12.0, uy - DOOR_TOP) <= DOOR_R
                    ):
                        col = LIT
                    r_acc += col[0]
                    g_acc += col[1]
                    b_acc += col[2]
            n = SS * SS
            i = (y * size + x) * 3
            buf[i] = int(r_acc / n)
            buf[i + 1] = int(g_acc / n)
            buf[i + 2] = int(b_acc / n)
    return bytes(buf)


def write_png(path, size, rgb):
    raw = b"".join(
        b"\x00" + rgb[y * size * 3 : (y + 1) * size * 3] for y in range(size)
    )

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    print(f"  {path.name}  {size}x{size}  {len(png):,} bytes")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"writing icons to {OUT}")
    for name, size in (
        ("apple-touch-icon.png", 180),
        ("icon-192.png", 192),
        ("icon-512.png", 512),
    ):
        write_png(OUT / name, size, render(size))


if __name__ == "__main__":
    main()
