#!/usr/bin/env python3
"""Render the app icons: a record on a dark field. No image libraries needed."""
import math, struct, zlib, os

BG     = (0x0b, 0x0d, 0x10)
VINYL  = (0x17, 0x1b, 0x20)
GROOVE = (0x24, 0x2a, 0x31)
RIM    = (0x39, 0x42, 0x4d)
LABEL  = (0xff, 0xb0, 0x20)
LABEL2 = (0xd8, 0x8f, 0x12)

R_DISC, R_RIM_IN, R_LABEL, R_HOLE = 0.455, 0.442, 0.175, 0.019
GROOVE_FROM, GROOVE_TO = 0.195, 0.435


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def sample(nx, ny):
    """Colour at a point, coordinates normalised to -0.5..0.5 from the centre."""
    r = math.hypot(nx, ny)
    if r > R_DISC:
        return BG
    if r > R_RIM_IN:
        return RIM
    if r < R_HOLE:
        return BG
    if r < R_LABEL:
        c = LABEL if r < R_LABEL - 0.012 else LABEL2
        # a wedge of shadow so the label reads as a disc, not a flat dot
        shade = 0.10 * (0.5 + 0.5 * math.sin(math.atan2(ny, nx) + 2.2))
        return lerp(c, (0, 0, 0), shade)
    if GROOVE_FROM <= r <= GROOVE_TO:
        t = 0.5 + 0.5 * math.sin(r * 340.0)
        base = lerp(VINYL, GROOVE, 0.55 * t)
    else:
        base = VINYL
    # light from the upper left, fixed while the record turns
    sheen = max(0.0, (-nx * 0.7 - ny * 0.7) / 0.64) ** 2 * 0.22
    return lerp(base, (0xff, 0xff, 0xff), min(sheen, 0.22))


def render(size, ss=3):
    rows = []
    step = 1.0 / (size * ss)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = [0, 0, 0]
            for sy in range(ss):
                ny = (y * ss + sy + 0.5) * step - 0.5
                for sx in range(ss):
                    nx = (x * ss + sx + 0.5) * step - 0.5
                    c = sample(nx, ny)
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
            n = ss * ss
            row += bytes((acc[0] // n, acc[1] // n, acc[2] // n))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b''.join(b'\x00' + r for r in rows)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path}  {size}x{size}  {len(png)} bytes')


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(__file__), '..', 'icons')
    os.makedirs(out, exist_ok=True)
    for size, ss in ((180, 4), (192, 4), (512, 3)):
        write_png(os.path.join(out, f'icon-{size}.png'), render(size, ss), size)
