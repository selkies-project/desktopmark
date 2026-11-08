"""fidelity.py <page.rgb> <x.rgb> <w> <h>: compares a stream's pixels with the X server's own.
fidelity.py --curve <x.rgb> <w> <h> <page.rgb>...: [SSIM, PSNR] of each page capture against one reference.

The scores are computed on RGB, what the viewer shows, so no stack's colour matrix is favoured:
SSIM is the mean of the R, G and B channels' SSIM (8x8 box windows) and PSNR is over all three
channels together. Luma scores computed with one matrix (BT.601 here) cancel the chroma errors of
a stream encoded with that same matrix and count them for one encoded with another (BT.709), so
they are kept only as diagnostics (ssimY, psnrY), with per-channel PSNR and the chroma error.
"""
import json
import sys

import numpy as np


def load(path, w, h):
    return np.fromfile(path, dtype=np.uint8).reshape(h, w, 3).astype(np.float64)


def ycbcr(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    return y, 128 + (b - y) * 0.564, 128 + (r - y) * 0.713


def box(a, k=8):
    h, w = (a.shape[0] // k) * k, (a.shape[1] // k) * k
    return a[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3))


def ssim(x, y):
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mx, my = box(x), box(y)
    vx, vy, cxy = box(x * x) - mx * mx, box(y * y) - my * my, box(x * y) - mx * my
    s = ((2 * mx * my + c1) * (2 * cxy + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2))
    return float(s.mean())


def psnr(x, y):
    mse = float(((x - y) ** 2).mean())
    return 99.0 if mse == 0 else 10 * np.log10(255 * 255 / mse)


def ssim_rgb(a, b):
    return sum(ssim(a[..., i], b[..., i]) for i in range(3)) / 3


def main():
    if sys.argv[1] == "--curve":
        ref, w, h = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
        ref_rgb = load(ref, w, h)
        out = []
        for p in sys.argv[5:]:
            a = load(p, w, h)
            out.append([round(ssim_rgb(a, ref_rgb), 5), round(psnr(a, ref_rgb), 2)])
        print(json.dumps(out))
        return
    page, ref, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    a, b = load(page, w, h), load(ref, w, h)
    ya, cba, cra = ycbcr(a)
    yb, cbb, crb = ycbcr(b)
    print(json.dumps({
        "ssim": round(ssim_rgb(a, b), 5),
        "psnr": round(psnr(a, b), 2),
        "ssimY": round(ssim(ya, yb), 5),
        "psnrY": round(psnr(ya, yb), 2),
        "psnrRGB": [round(psnr(a[..., i], b[..., i]), 2) for i in range(3)],
        "chromaErr": round(float((np.abs(cba - cbb) + np.abs(cra - crb)).mean() / 2), 3),
    }))


main()
