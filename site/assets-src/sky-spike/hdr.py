import numpy as np


def read_hdr(path):
    data = open(path, 'rb').read()
    i = data.index(b'\n\n') + 2
    j = data.index(b'\n', i)
    line = data[i:j].decode().split()
    H = int(line[1]); W = int(line[3]); p = j + 1
    img = np.zeros((H, W, 4), np.uint8)
    for y in range(H):
        assert data[p] == 2 and data[p + 1] == 2
        p += 4
        for c in range(4):
            x = 0
            while x < W:
                n = data[p]; p += 1
                if n > 128:
                    n -= 128; img[y, x:x + n, c] = data[p]; p += 1
                else:
                    img[y, x:x + n, c] = np.frombuffer(data, np.uint8, n, p); p += n
                x += n
    e = img[..., 3].astype(np.float32)
    m = np.where(e > 0, np.ldexp(1.0, (e - 136).astype(int)), 0).astype(np.float32)
    return img[..., :3].astype(np.float32) * m[..., None]


def view(env, yaw, pitch, fov, w, h):
    H, W, _ = env.shape
    tanx = np.tan(np.radians(fov) / 2)
    xs = (np.arange(w) + .5) / w * 2 - 1
    ys = 1 - (np.arange(h) + .5) / h * 2
    X, Y = np.meshgrid(xs * tanx, ys * tanx * h / w)
    d = np.stack([X, Y, np.ones_like(X)], -1)
    cp, sp = np.cos(np.radians(pitch)), np.sin(np.radians(pitch))
    y1 = d[..., 1] * cp + d[..., 2] * sp
    z1 = -d[..., 1] * sp + d[..., 2] * cp
    x1 = d[..., 0]
    cy, sy = np.cos(np.radians(yaw)), np.sin(np.radians(yaw))
    x2 = x1 * cy + z1 * sy
    z2 = -x1 * sy + z1 * cy
    lon = np.arctan2(x2, z2)
    lat = np.arctan2(y1, np.hypot(x2, z2))
    u = (lon / (2 * np.pi) + .5) * W
    v = (0.5 - lat / np.pi) * H
    u0 = np.floor(u).astype(int) % W
    v0 = np.clip(np.floor(v).astype(int), 0, H - 2)
    fu = (u - np.floor(u))[..., None]
    fv = (v - np.floor(v))[..., None]
    u1 = (u0 + 1) % W
    return (env[v0, u0] * (1 - fu) * (1 - fv) + env[v0, u1] * fu * (1 - fv)
            + env[v0 + 1, u0] * (1 - fu) * fv + env[v0 + 1, u1] * fu * fv)


def tonemap(x, exp, gamma=2.2):
    return np.clip(1 - np.exp(-x * exp), 0, 1) ** (1 / gamma)
