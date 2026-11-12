import importlib.util
import plistlib
import struct
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('macos_bundle', Path(__file__).parent.parent / 'lib/macos-bundle.py')
macos_bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(macos_bundle)

PNG = b'\x89PNG\r\n\x1a\n'


def icns(*entries):
    body = b''.join(struct.pack('>4sI', kind, len(data) + 8) + data for kind, data in entries)
    return b'icns' + struct.pack('>I', len(body) + 8) + body


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_info_reads_versions_and_integrity(self):
        electron = self.dir / macos_bundle.ELECTRON_PLIST
        electron.parent.mkdir(parents=True)
        electron.write_bytes(plistlib.dumps({'CFBundleVersion': '44.9.1'}, fmt=plistlib.FMT_BINARY))
        (self.dir / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleShortVersionString': '7.43.0', 'CFBundleIdentifier': 'notion.id', 'CFBundleName': 'Notion',
            'CFBundleIconFile': 'electron',
            'CFBundleURLTypes': [{'CFBundleURLSchemes': ['notion', 'notion-agents']}, {'CFBundleURLSchemes': ['bad scheme', 'x/y']}],
            'ElectronAsarIntegrity': {'Resources/app.asar': {'algorithm': 'SHA256', 'hash': 'ab'}},
        }))
        self.assertEqual(macos_bundle.bundle_info(self.dir), {
            'version': '7.43.0', 'bundleId': 'notion.id', 'name': 'Notion', 'electron': '44.9.1', 'asarHeaderSha256': 'ab',
            'urlSchemes': ['notion', 'notion-agents'], 'iconFile': 'electron.icns'})

    def test_info_requires_asar_integrity(self):
        (self.dir / macos_bundle.ELECTRON_PLIST).parent.mkdir(parents=True)
        (self.dir / macos_bundle.ELECTRON_PLIST).write_bytes(plistlib.dumps({'CFBundleVersion': '1.0.0'}))
        (self.dir / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString': '1', 'CFBundleIdentifier': 'x'}))
        with self.assertRaises(SystemExit):
            macos_bundle.bundle_info(self.dir)

    def test_icon_picks_largest_png_up_to_512(self):
        source = self.dir / 'icon.icns'
        source.write_bytes(icns((b'ic07', PNG + b'128'), (b'ic09', PNG + b'512'), (b'ic10', PNG + b'1024'), (b'is32', b'raw')))
        self.assertEqual(macos_bundle.extract_icon(source, self.dir / 'out.png'), 512)
        self.assertEqual((self.dir / 'out.png').read_bytes(), PNG + b'512')

    def test_recolor_keeps_alpha_and_replaces_colour(self):
        import zlib
        rows = [bytes([0, 0, 0, 0]) + bytes([10, 20, 30, 128]), bytes([1, 2, 3, 255]) + bytes([0, 0, 0, 0])]
        # Filter 1 (Sub) on the second row exercises filter decoding.
        sub = bytes([1, 2, 3, 255]) + bytes((0 - v) & 255 for v in [1, 2, 3, 255])
        raw = b'\x00' + rows[0] + b'\x01' + sub
        png = (b'\x89PNG\r\n\x1a\n' + macos_bundle._chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 6, 0, 0, 0))
               + macos_bundle._chunk(b'IDAT', zlib.compress(raw)) + macos_bundle._chunk(b'IEND', b''))
        (self.dir / 'in.png').write_bytes(png)
        macos_bundle.recolor(self.dir / 'in.png', self.dir / 'out.png', 'ffffff')
        out = dict(macos_bundle._chunks((self.dir / 'out.png').read_bytes()))
        pixels = zlib.decompress(out[b'IDAT'])
        self.assertEqual(pixels, b'\x00' + bytes([255, 255, 255, 0, 255, 255, 255, 128]) + b'\x00' + bytes([255, 255, 255, 255, 255, 255, 255, 0]))
        with self.assertRaises(SystemExit):
            macos_bundle.recolor(self.dir / 'in.png', self.dir / 'bad.png', 'white')

    def test_icon_rejects_non_icns(self):
        (self.dir / 'bad').write_bytes(b'nope')
        with self.assertRaises(SystemExit):
            macos_bundle.extract_icon(self.dir / 'bad', self.dir / 'out.png')


if __name__ == '__main__':
    unittest.main()
