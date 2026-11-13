#!/usr/bin/env python3
"""Verify the shared official Linux NDK archive before unpacking, including cache hits."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import unittest


def verify(archive, expected=None):
    archive = Path(archive)
    expected = expected or json.loads(Path(__file__).with_name('linux-inputs.json').read_text())
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size != expected['ndkSize']:
        raise ValueError('NDK archive type or size mismatch')
    hashes = {name: hashlib.new(name) for name in ['sha1', 'sha256']}
    with archive.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            for digest in hashes.values(): digest.update(block)
    if any(digest.hexdigest() != expected['ndk' + name.capitalize()] for name, digest in hashes.items()):
        raise ValueError('NDK archive digest mismatch')


class ArchiveTests(unittest.TestCase):
    def test_valid_size_poison_and_link_controls(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'ndk.zip'
            archive.write_bytes(b'good')
            expected = dict(ndkSize=4, ndkSha1=hashlib.sha1(b'good').hexdigest(), ndkSha256=hashlib.sha256(b'good').hexdigest())
            verify(archive, expected)
            for bad in [b'evil', b'truncated']:
                archive.write_bytes(bad)
                with self.assertRaises(ValueError): verify(archive, expected)
            archive.unlink()
            archive.symlink_to(Path(directory) / 'outside')
            with self.assertRaises(ValueError): verify(archive, expected)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', nargs='?')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ArchiveTests))
        raise SystemExit(0 if result.wasSuccessful() else 1)
    verify(args.archive)
