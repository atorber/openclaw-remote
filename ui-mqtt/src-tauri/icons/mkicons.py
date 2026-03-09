#!/usr/bin/env python3
"""Generate placeholder PNGs for Tauri iconset and ico."""
import struct
import zlib

ICONSET = "icon.iconset"


def png_chunk(typ: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + typ + data + struct.pack(
        ">I", zlib.crc32(typ + data) & 0xFFFFFFFF
    )


def make_png(w: int, h: int) -> bytes:
    # RGBA (color type 6), one byte filter per row + width*4 bytes
    raw = b"".join(b"\x00" + (b"\x6a\x6a\x6a\xff" * w) for _ in range(h))
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    return sig + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", idat) + png_chunk(b"IEND", b"")


def main() -> None:
    import os
    base = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(base, ICONSET), exist_ok=True)
    for s in (16, 32, 64, 128, 256, 512):
        path = os.path.join(base, ICONSET, f"icon_{s}x{s}.png")
        open(path, "wb").write(make_png(s, s))
        if s <= 256:
            path2 = os.path.join(base, ICONSET, f"icon_{s}x{s}@2x.png")
            open(path2, "wb").write(make_png(s * 2, s * 2))
    # Tauri bundle expects these names in icons/
    open(os.path.join(base, "32x32.png"), "wb").write(make_png(32, 32))
    open(os.path.join(base, "128x128.png"), "wb").write(make_png(128, 128))
    open(os.path.join(base, "128x128@2x.png"), "wb").write(make_png(256, 256))
    # Minimal 32x32 ico (single image)
    ico_path = os.path.join(base, "icon.ico")
    png32 = make_png(32, 32)
    # ICO: 6-byte header, 16-byte entry, then BMP-like data
    ico_header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 32, 32, 0, 0, 1, 32, len(png32) + 22, 22)
    # BMP in ICO: 40-byte DIB header + raw BMP data (bottom-up, 32bpp)
    bmp_header = struct.pack(
        "<IiiHHIIiiII", 40, 32, 64, 1, 32, 0, 0, 0, 0, 0, 0
    )
    row = 32 * 4
    pad = (4 - (row % 4)) % 4
    raw_bmp = b"".join(
        b"\x00" + b"\x6a\x6a\x6a\x00" * 32 for _ in range(32)
    )[::-1]  # bottom-up
    open(ico_path, "wb").write(ico_header + entry + bmp_header + raw_bmp)
    print("icon.ico (minimal), iconset ready for iconutil -c icns")


if __name__ == "__main__":
    main()
