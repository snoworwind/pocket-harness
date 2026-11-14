#!/usr/bin/env python3
"""Block retired Linux plugins, bundles and native executables from shipped artifacts."""
import argparse
import io
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path


def check_names(names):
    for name in names:
        parts = name.split('/')
        if any(p in {'linux-bootstrap', 'dsh-linux-bootstrap', 'dsh-linux-runtime', 'linux-runtime', 'linux-bundle', 'linux-assets'} for p in parts) or any(p.startswith('libpocketharness_proot') for p in parts):
            raise ValueError('retired Linux payload in artifact: ' + name)
        if name.endswith(('/linux-release.json', '/linux-runtime-manifest.sha256', '/linux-environment.js', '/linux-host-asset-io.js', '/linux-tool-contract.js')):
            raise ValueError('retired Linux configuration in artifact: ' + name)


def verify(path, apk=False):
    if apk:
        with zipfile.ZipFile(path) as archive:
            check_names(archive.namelist())
    else:
        with tarfile.open(path, 'r|*') as archive:
            check_names(member.name for member in archive)


class RemovalTests(unittest.TestCase):
    def test_termux_survives_and_linux_payloads_are_rejected(self):
        check_names(['usr/bin/bash', 'usr/lib/node_modules/dsh-android-linux-env/lib/index.js'])
        for name in ['usr/lib/node_modules/@dsh-android/linux-bootstrap/lib/index.js',
                     'usr/lib/linux-bundle/linux-release.json', 'usr/share/pocket-harness/linux-assets/node.tar.xz',
                     'usr/lib/node_modules/@dsh-android/linux-runtime/lib/index.js', 'lib/arm64-v8a/libpocketharness_proot.so',
                     'usr/lib/node_modules/dsh-android-linux-env/lib/linux-environment.js']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                check_names([name])

    def test_actual_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for bad in (False, True):
                name = 'usr/lib/linux-bundle/linux-release.json' if bad else 'usr/bin/bash'
                tar = root / 'snapshot.tar.xz'
                with tarfile.open(tar, 'w:xz') as archive:
                    info = tarfile.TarInfo(name)
                    info.size = 1
                    archive.addfile(info, io.BytesIO(b'x'))
                apk = root / 'app.apk'
                with zipfile.ZipFile(apk, 'w') as archive:
                    archive.writestr('lib/arm64-v8a/libpocketharness_proot.so' if bad else 'assets/snapshot.tar.xz', b'x')
                for path, is_apk in [(tar, False), (apk, True)]:
                    if bad:
                        with self.assertRaises(ValueError): verify(path, is_apk)
                    else:
                        verify(path, is_apk)


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['--self-test']:
        unittest.main(argv=[sys.argv[0]])
    else:
        parser = argparse.ArgumentParser()
        parser.add_argument('path')
        parser.add_argument('--apk', action='store_true')
        args = parser.parse_args()
        verify(args.path, args.apk)
        print('Retired Linux payloads absent: ' + args.path)
