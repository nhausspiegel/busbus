#!/usr/bin/env python3
"""Rasterise public/icon.svg to the PNG iOS needs for a home-screen icon.

Safari ignores an SVG in the web app manifest, so "Add to Home Screen" on an
iPhone falls back to a screenshot of the page unless there is a PNG
`apple-touch-icon`. Android honours the SVG, which is why one was enough until
now.

Written against the standard library on purpose. macOS ships no SVG rasteriser
(no rsvg-convert, inkscape or ImageMagick) and the venv has neither Pillow nor
cairosvg -- pulling in a dependency to draw seven rectangles once is not worth
it. The shapes are duplicated from icon.svg below; there are seven of them and
they change roughly never.

iOS rounds the corners itself, so the square is drawn full-bleed. Rounding it
here as icon.svg does would show as a rounded icon inside iOS's own rounding.

    ./.venv/bin/python scripts/make-icons.py
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "apple-touch-icon.png"

# 180 is what iOS asks for on a @3x home screen; it downscales for everything
# smaller. The shapes below are in icon.svg's 512-unit space.
SIZE = 180
VIEWBOX = 512
SAMPLES = 4          # per axis, so 16 samples a pixel -- enough for clean curves

INK = (0x24, 0x1C, 0x17)
PAPER = (0xFB, 0xF8, 0xF5)
ACCENT = (0xC8, 0x10, 0x2E)

# (kind, geometry, colour), painted in order. Straight from icon.svg, minus its
# rounded outer corner.
SHAPES = [
    ("rect", (0, 0, 512, 512, 0), INK),
    ("rect", (140, 112, 232, 248, 44), PAPER),      # body
    ("rect", (170, 150, 172, 96, 16), INK),         # windscreen
    ("circle", (196, 300, 26), ACCENT),             # headlights
    ("circle", (316, 300, 26), ACCENT),
    ("rect", (168, 368, 52, 44, 14), PAPER),        # wheels
    ("rect", (292, 368, 52, 44, 14), PAPER),
]


def rect_covers(px, py, g):
    """Signed-distance test for a rounded rectangle."""
    x, y, w, h, r = g
    qx = abs(px - (x + w / 2)) - (w / 2 - r)
    qy = abs(py - (y + h / 2)) - (h / 2 - r)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    return min(max(qx, qy), 0.0) + outside - r <= 0


def circle_covers(px, py, g):
    cx, cy, r = g
    return math.hypot(px - cx, py - cy) <= r


def render():
    scale = VIEWBOX / SIZE
    step = scale / SAMPLES
    rows = []
    for py in range(SIZE):
        row = bytearray()
        for px in range(SIZE):
            r = g = b = 0
            for kind, geom, colour in SHAPES:
                hits = 0
                for sy in range(SAMPLES):
                    vy = (py + (sy + 0.5) / SAMPLES) * scale
                    for sx in range(SAMPLES):
                        vx = (px + (sx + 0.5) / SAMPLES) * scale
                        covers = rect_covers if kind == "rect" else circle_covers
                        if covers(vx, vy, geom):
                            hits += 1
                if not hits:
                    continue
                a = hits / (SAMPLES * SAMPLES)
                r = round(r + (colour[0] - r) * a)
                g = round(g + (colour[1] - g) * a)
                b = round(b + (colour[2] - b) * a)
            row += bytes((r, g, b))
        rows.append(row)
    _ = step
    return rows


def write_png(path, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)   # filter type 0 per scanline

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0)   # 8-bit RGB
    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", header)
                     + chunk(b"IDAT", zlib.compress(raw, 9))
                     + chunk(b"IEND", b""))


def selftest(rows):
    assert len(rows) == SIZE and len(rows[0]) == SIZE * 3, "wrong dimensions"
    px = lambda x, y: tuple(rows[y][x * 3:x * 3 + 3])
    # A corner is background: iOS does the rounding, so this must NOT be blank.
    assert px(1, 1) == INK, f"corner {px(1, 1)} should be the full-bleed background"
    # Middle of the windscreen, and middle of the body below it.
    assert px(SIZE // 2, 38) == INK, "windscreen missing"
    assert px(SIZE // 2, 100) == PAPER, "body missing"
    # A headlight, at 196/512 across and 300/512 down.
    assert px(round(196 / VIEWBOX * SIZE), round(300 / VIEWBOX * SIZE)) == ACCENT, \
        "headlight missing"
    print(f"selftest ok: {SIZE}x{SIZE}")


if __name__ == "__main__":
    rows = render()
    selftest(rows)
    write_png(OUT, rows)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
