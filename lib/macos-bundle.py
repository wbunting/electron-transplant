#!/usr/bin/env python3
"""Read metadata and the icon from an extracted (untrusted) macOS .app bundle.

info CONTENTS_DIR      print JSON: versions, bundle id, asar integrity, URL schemes, icon file
icon ICNS OUT_PNG      write the largest embedded PNG (<= 512px) from an .icns file
recolor IN OUT RRGGBB  fill an 8-bit RGBA PNG's colour, keeping its alpha (macOS template
                       icons are alpha masks the system tints)
"""
import json
import plistlib
import struct
import sys
import zlib
from pathlib import Path

ELECTRON_PLIST = 'Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist'
# icns types whose payload is PNG, by pixel size; prefer the largest <= 512.
PNG_TYPES = {b'ic09': 512, b'ic14': 512, b'ic08': 256, b'ic13': 256, b'ic07': 128}


def bundle_info(contents: Path) -> dict:
    with (contents / 'Info.plist').open('rb') as stream:
        app = plistlib.load(stream)
    with (contents / ELECTRON_PLIST).open('rb') as stream:
        electron = plistlib.load(stream)
    integrity = app.get('ElectronAsarIntegrity', {}).get('Resources/app.asar', {})
    if integrity.get('algorithm') != 'SHA256':
        raise SystemExit('Bundle has no SHA256 ElectronAsarIntegrity for app.asar')
    schemes = sorted({
        scheme
        for url_type in app.get('CFBundleURLTypes', [])
        for scheme in url_type.get('CFBundleURLSchemes', [])
        if isinstance(scheme, str) and scheme.isascii() and scheme.replace('-', '').replace('.', '').replace('+', '').isalnum()
    })
    icon = app.get('CFBundleIconFile')
    if isinstance(icon, str) and icon and '/' not in icon and not icon.endswith('.icns'):
        icon += '.icns'
    return {
        'version': app['CFBundleShortVersionString'],
        'bundleId': app['CFBundleIdentifier'],
        'name': app.get('CFBundleName'),
        'electron': electron['CFBundleVersion'],
        'asarHeaderSha256': integrity['hash'],
        'urlSchemes': schemes,
        'iconFile': icon if isinstance(icon, str) and '/' not in icon else None,
    }


def extract_icon(icns: Path, out: Path) -> int:
    data = icns.read_bytes()
    if data[:4] != b'icns':
        raise SystemExit('Not an icns file')
    best, best_size, offset = None, 0, 8
    while offset + 8 <= len(data):
        kind, length = struct.unpack('>4sI', data[offset:offset + 8])
        if length < 8:
            break
        payload = data[offset + 8:offset + length]
        size = PNG_TYPES.get(kind, 0)
        if size > best_size and payload.startswith(b'\x89PNG\r\n\x1a\n'):
            best, best_size = payload, size
        offset += length
    if best is None:
        raise SystemExit('No PNG icon found in icns')
    out.write_bytes(best)
    return best_size


def _chunks(data: bytes):
    offset = 8
    while offset + 8 <= len(data):
        length, kind = struct.unpack('>I4s', data[offset:offset + 8])
        yield kind, data[offset + 8:offset + 8 + length]
        offset += 12 + length


def _chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload) & 0xFFFFFFFF)


def recolor(source: Path, out: Path, color: str) -> None:
    data = source.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit('Not a PNG')
    header = None
    compressed = b''
    for kind, payload in _chunks(data):
        if kind == b'IHDR':
            header = struct.unpack('>IIBBBBB', payload)
        elif kind == b'IDAT':
            compressed += payload
    if header is None:
        raise SystemExit('PNG has no IHDR')
    width, height, depth, color_type, _, _, interlace = header
    if depth != 8 or color_type != 6 or interlace != 0:
        raise SystemExit('Only 8-bit non-interlaced RGBA PNGs are supported')
    if len(color) != 6 or any(c not in '0123456789abcdefABCDEF' for c in color):
        raise SystemExit('Colour must be RRGGBB')
    rgb = bytes.fromhex(color)
    raw = zlib.decompress(compressed)
    stride = width * 4
    previous = bytearray(stride)
    rows = []
    for y in range(height):
        start = y * (stride + 1)
        kind, line = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        for x in range(stride):
            a = line[x - 4] if x >= 4 else 0
            b = previous[x]
            c = previous[x - 4] if x >= 4 else 0
            if kind == 1:
                line[x] = (line[x] + a) & 255
            elif kind == 2:
                line[x] = (line[x] + b) & 255
            elif kind == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif kind == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
            elif kind != 0:
                raise SystemExit(f'Unknown PNG filter {kind}')
        previous = line
        rows.append(bytes(v for px in range(width) for v in (*rgb, line[px * 4 + 3])))
    body = b''.join(b'\x00' + row for row in rows)
    out.write_bytes(b'\x89PNG\r\n\x1a\n' + _chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
                    + _chunk(b'IDAT', zlib.compress(body, 9)) + _chunk(b'IEND', b''))


def main(argv: list[str]) -> None:
    if len(argv) == 2 and argv[0] == 'info':
        print(json.dumps(bundle_info(Path(argv[1]))))
    elif len(argv) == 3 and argv[0] == 'icon':
        print(extract_icon(Path(argv[1]), Path(argv[2])))
    elif len(argv) == 4 and argv[0] == 'recolor':
        recolor(Path(argv[1]), Path(argv[2]), argv[3])
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
