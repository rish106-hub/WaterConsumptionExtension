#!/usr/bin/env python3
"""Generate placeholder AquaAI icons (blue rounded square + white water drop).

Pure standard library (zlib + struct) — no Pillow required.
Run:  python3 tools/make_icons.py
Outputs icons/icon16.png, icon48.png, icon128.png.
"""
import os
import struct
import zlib

BG = (30, 136, 229)      # accent blue
DROP = (255, 255, 255)   # white


def in_drop(x, y, n):
    """Approximate a teardrop occupying the centre of an n x n canvas."""
    cx = n / 2.0
    # normalised vertical position 0..1 over the drop's bounding box
    top = n * 0.18
    bottom = n * 0.82
    if y < top or y > bottom:
        return False
    t = (y - top) / (bottom - top)          # 0 at tip, 1 at base
    # width grows then the bottom is a circle; simple lens/teardrop profile
    if t < 0.55:
        half = (t / 0.55) * (n * 0.30)
    else:
        # lower bulb as a circle
        r = n * 0.30
        by = top + 0.55 * (bottom - top) + r * 0.55
        dy = y - by
        if abs(dy) > r:
            return False
        half = (r * r - dy * dy) ** 0.5
    return abs(x - cx) <= half


def rounded(x, y, n, radius):
    """True if pixel is inside a rounded-square mask."""
    for ax, ay in ((radius, radius), (n - radius, radius),
                   (radius, n - radius), (n - radius, n - radius)):
        if ((x < radius and y < radius) or (x >= n - radius and y < radius) or
                (x < radius and y >= n - radius) or (x >= n - radius and y >= n - radius)):
            # in a corner region: check distance to the corresponding centre
            pass
    # simpler: check each corner circle
    corners = [(radius, radius), (n - radius - 1, radius),
               (radius, n - radius - 1), (n - radius - 1, n - radius - 1)]
    in_corner_box = (x < radius or x >= n - radius) and (y < radius or y >= n - radius)
    if not in_corner_box:
        return True
    for cx, cy in corners:
        if (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2:
            return True
    return False


def make_png(n):
    radius = max(2, n // 6)
    raw = bytearray()
    for y in range(n):
        raw.append(0)  # filter type 0 for this scanline
        for x in range(n):
            if not rounded(x, y, n, radius):
                raw.extend((0, 0, 0, 0))            # transparent outside
            elif in_drop(x, y, n):
                raw.extend((*DROP, 255))
            else:
                raw.extend((*BG, 255))
    return _png_bytes(n, n, bytes(raw))


def _chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))


def _png_bytes(w, h, raw_rgba):
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(raw_rgba, 9)
    return sig + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")


def main():
    out = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(out, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(out, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(make_png(size))
        print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    main()
