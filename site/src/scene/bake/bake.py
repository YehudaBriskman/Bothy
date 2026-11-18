"""Bakes the sky-scene gallery photographs (slice S6, "Sky scenes") from Poly Haven pure-sky HDRIs (CC0 1.0).

Usage (RAW is a folder with the 4k .hdr files; OUT receives <key>-desk.avif and report.json):
    RAW=raw OUT=../../../public/scene-mock/img uv run --with pillow --with numpy python bake.py [avif_byte_target]

Same recipe as site/assets-src/sky/bake.py (a flat rectilinear view of the equirectangular HDR, a fixed exposure
chosen so the 60th percentile of luminance lands at p60, a soft-shoulder tone map, AVIF searched down to the byte
target). Only the views differ: they look at the horizon (pitch 14 to 22 degrees) instead of away from it, so the
skyline of each scene is a real cloud edge or a real glow band, not a drawn one. Nothing here draws a cloud.
"""

import hashlib
import io
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'assets-src', 'sky-spike'))
from hdr import read_hdr, view, tonemap  # noqa: E402

# key -> (poly haven id, yaw, pitch, fov, p60 target)
SCENES = {
    'glow': ('syferfontein_1d_clear_puresky', 125, 20, 84, 0.34),
    'cumulus': ('table_mountain_1_puresky', 85, 19, 84, 0.30),
    'deck': ('evening_road_01_puresky', 70, 18, 84, 0.32),
    'dawn': ('kloppenheim_01_puresky', 22, 18, 84, 0.34),
    'storm': ('wasteland_clouds_puresky', 55, 19, 84, 0.28),
    'cirrus': ('rocky_ridge_puresky', 112, 22, 84, 0.32),
    'twilight': ('qwantani_dusk_2_puresky', 20, 18, 84, 0.34),
}
target = int(sys.argv[1]) if len(sys.argv) > 1 else 31000
RAW = os.environ.get('RAW', 'raw')
OUT = os.environ.get('OUT', 'out')
os.makedirs(OUT, exist_ok=True)
rep = {}
for key, (src, yaw, pit, fov, p60) in SCENES.items():
    path = f'{RAW}/{src}_4k.hdr' if os.path.exists(f'{RAW}/{src}_4k.hdr') else f'{RAW}/{src}.hdr'
    sha = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    env = read_hdr(path)
    ref = view(env, yaw, pit, fov, 480, 300)
    l60 = np.percentile(ref.mean(2), 60)
    exp = -np.log(1 - p60) / max(l60, 1e-6)
    v = view(env, yaw, pit, fov, 1280, 800)
    im = Image.fromarray((tonemap(v, exp) * 255 + 0.5).astype(np.uint8))
    im.save(f'{OUT}/{key}-desk.png')
    lo, hi, best = 5, 90, None
    while lo <= hi:
        q = (lo + hi) // 2
        b = io.BytesIO()
        im.save(b, 'AVIF', quality=q, speed=4)
        if b.tell() <= target:
            best = (q, b.getvalue())
            lo = q + 1
        else:
            hi = q - 1
    q, data = best
    open(f'{OUT}/{key}-desk.avif', 'wb').write(data)
    rep[key] = dict(src=src, sourceSha256=sha, yaw=yaw, pitch=pit, fov=fov, avif_q=q, bytes=len(data), exp=float(exp))
    print(key, rep[key], flush=True)
json.dump(rep, open(f'{OUT}/report.json', 'w'), indent=1)
