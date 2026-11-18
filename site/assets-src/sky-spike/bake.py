import numpy as np, sys, os, io, json
from PIL import Image, ImageFilter, ImageChops
from hdr import read_hdr, view, tonemap

# name -> (src, yaw, pitch, fov_desktop, fov_phone, pitch_phone, p60 target, kind)
P = {
    'day':   ('kloofendal_48d_partly_cloudy_puresky', 214, 27, 84, 56, 36, 0.30),
    'dusk':  ('kloppenheim_06_puresky', 41 - 50, 27, 84, 56, 30, 0.32),
    'night': ('kloppenheim_02_puresky', 36 + 50, 20, 84, 56, 28, 0.030),
}
target = {'desk': int(sys.argv[1]) if len(sys.argv) > 1 else 58000, 'phone': int(sys.argv[2]) if len(sys.argv) > 2 else 28000}
os.makedirs('out', exist_ok=True)
rep = {}
for name, (src, yaw, pit, fovd, fovp, pitp, p60) in P.items():
    env = read_hdr('raw4/%s.hdr' % src)
    ref = view(env, yaw, pit, fovd, 480, 300)
    ex = -np.log(1 - 0.5) / 1.0
    # exposure so that the 60th percentile of luminance lands at p60 (before the soft shoulder)
    l60 = np.percentile(ref.mean(2), 60)
    exp = -np.log(1 - p60) / max(l60, 1e-6)
    for kind, (w, h, fov, pt) in {'desk': (1600, 1000, fovd, pit), 'phone': (640, 960, fovp, pitp)}.items():
        v = view(env, yaw, pt, fov, w, h)
        im = Image.fromarray((tonemap(v, exp) * 255 + 0.5).astype(np.uint8))
        if name == 'night':
            bl = im.filter(ImageFilter.GaussianBlur(2.5))
            hp = ImageChops.subtract(im, bl)
            im = ImageChops.add(im, hp.point(lambda x: min(255, x * 3)))
        im.save('out/%s-%s.png' % (name, kind))
        lo, hi, best = 5, 90, None
        while lo <= hi:
            q = (lo + hi) // 2
            b = io.BytesIO(); im.save(b, 'AVIF', quality=q, speed=4)
            if b.tell() <= target[kind]:
                best = (q, b.getvalue()); lo = q + 1
            else:
                hi = q - 1
        q, data = best
        open('out/%s-%s.avif' % (name, kind), 'wb').write(data)
        lo, hi, bw = 5, 95, None
        while lo <= hi:
            qq = (lo + hi) // 2
            b = io.BytesIO(); im.save(b, 'WEBP', quality=qq, method=6)
            if b.tell() <= {'desk': 59500, 'phone': 29800}[kind]:
                bw = (qq, b.getvalue()); lo = qq + 1
            else:
                hi = qq - 1
        open('out/%s-%s.webp' % (name, kind), 'wb').write(bw[1])
        rep['%s-%s' % (name, kind)] = dict(avif_q=q, avif=len(data), webp_q=bw[0], webp=len(bw[1]), exp=float(exp))
        print(name, kind, rep['%s-%s' % (name, kind)])
json.dump(rep, open('out/report.json', 'w'), indent=1)
