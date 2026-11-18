# Sky spike: image provenance

Machine-readable twin: `ASSETS.json` (bytes and sha256 per file; `src/sky-spike.test.ts` fails the build on a file
without an entry, a licence that is not CC0, or a hash that no longer matches).

All three photographs are **Poly Haven "pure sky" HDRIs, licence CC0 1.0 (public domain dedication)**. Each licence was
read on the asset's own page (its structured data says `license: https://creativecommons.org/publicdomain/zero/1.0/`)
and on https://polyhaven.com/license ("CC0 means absolute freedom"), on 2026-11-18. No attribution is required; it is
given anyway.

| Use | Asset (page) | Authors | Taken | Licence | Source file |
|---|---|---|---|---|---|
| day | [Kloofendal 48d Partly Cloudy (Pure Sky)](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) | Greg Zaal (original), Jarod Guest (sky edits) | 2019-03-22 | CC0 1.0 | `HDRIs/hdr/4k/kloofendal_48d_partly_cloudy_puresky_4k.hdr` |
| dusk | [Kloppenheim 06 (Pure Sky)](https://polyhaven.com/a/kloppenheim_06_puresky) | Greg Zaal (original), Jarod Guest (sky edits) | 2019-11-03 | CC0 1.0 | `HDRIs/hdr/4k/kloppenheim_06_puresky_4k.hdr` |
| night | [Kloppenheim 02 (Pure Sky)](https://polyhaven.com/a/kloppenheim_02_puresky) | Greg Zaal (original), Jarod Guest (sky edits) | 2019-11-02 | CC0 1.0 | `HDRIs/hdr/4k/kloppenheim_02_puresky_4k.hdr` |

## What was done to them

A 4096 by 2048 equirectangular HDR is reprojected to a flat 84 degree view (a 56 degree portrait view for phones)
looking away from the sun or moon, tone-mapped at a fixed exposure with a soft shoulder, and encoded to AVIF with a
WebP fallback. The night frame also gets a high-pass boost so the real stars survive compression. The recipe is
`site/assets-src/sky-spike/bake.py` (Python, Pillow and NumPy; no other tool was available: no `avifenc`, `cwebp`,
ImageMagick or sharp on this box). The sun, the moon and the extra stars are drawn by the shader, not photographed.
