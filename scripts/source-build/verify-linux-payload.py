#!/usr/bin/env python3
"""Verify the final APK's Linux assets against their manifest, without extraction."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

PAYLOADS = ('rootfs', 'node', 'engine', 'home')


def verify(apk):
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('duplicate APK member')
        if any(name in names for name in ('assets/snapshot.tar.xz', 'assets/snapshot.sha256')):
            raise ValueError('legacy runtime snapshot in Linux APK')
        raw = archive.read('assets/linux/manifest.json')
        manifest = json.loads(raw)
        if manifest.get('schemaVersion') != 1 or manifest.get('guestArchitecture') != 'arm64':
            raise ValueError('unsupported Linux instance schema or ABI')
        for key in ('rootfsTreeSha256', 'nodeTreeSha256', 'engineTreeSha256', 'homeSchemaVersion', 'baseId', 'minimumGlibc'):
            if not manifest.get(key):
                raise ValueError('missing Linux manifest field: ' + key)
        for name in PAYLOADS:
            digest = hashlib.sha256()
            with archive.open(f'assets/linux/{name}.tar.xz') as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            if digest.hexdigest() != manifest.get(name + 'Sha256'):
                raise ValueError('Linux payload digest mismatch: ' + name)
        hard = json.loads(archive.read('assets/plugin-hard-manifest.json'))
        if hard.get('schema') != 2 or hard.get('complete') is not True or not hard.get('entries'):
            raise ValueError('missing complete plugin ownership manifest')
        native = sorted(name for name in names if name.startswith('lib/'))
        for name in ('libpocketharness_terminal.so', 'libpocketharness_proot.so'):
            if f'lib/arm64-v8a/{name}' not in native:
                raise ValueError('missing required host native library: ' + name)
        if any(not name.startswith('lib/arm64-v8a/') for name in native):
            raise ValueError('unexpected host ABI in ARM64 APK')
        return dict(schemaVersion=1, mode='linux-guest', bundledTermuxSnapshot=False,
                    manifestSha256=hashlib.sha256(raw).hexdigest(), manifest=manifest,
                    assets=sorted(name for name in names if name.startswith('assets/')), nativeLibraries=native)


class Controls(unittest.TestCase):
    def test_valid_and_negative_controls(self):
        with tempfile.TemporaryDirectory() as temporary:
            apk = Path(temporary) / 'fixture.apk'
            manifest = dict(schemaVersion=1, guestArchitecture='arm64', homeSchemaVersion=2,
                            baseId='fixture', minimumGlibc='2.41', rootfsTreeSha256='tree',
                            nodeTreeSha256='tree', engineTreeSha256='tree')
            for name in PAYLOADS:
                manifest[name + 'Sha256'] = hashlib.sha256(name.encode()).hexdigest()
            def make(change=None):
                values = {'assets/linux/manifest.json': json.dumps(manifest),
                          'assets/plugin-hard-manifest.json': json.dumps(dict(schema=2, complete=True, entries=[{'name': 'fixture'}])),
                          'lib/arm64-v8a/libpocketharness_terminal.so': b'native',
                          'lib/arm64-v8a/libpocketharness_proot.so': b'native'}
                values.update({f'assets/linux/{name}.tar.xz': name.encode() for name in PAYLOADS})
                if change:
                    change(values)
                with zipfile.ZipFile(apk, 'w') as archive:
                    for name, data in values.items():
                        archive.writestr(name, data)
            make()
            self.assertEqual(verify(apk)['mode'], 'linux-guest')
            for change in [lambda x: x.update({'assets/linux/engine.tar.xz': b'tampered'}),
                           lambda x: x.pop('assets/linux/node.tar.xz'),
                           lambda x: x.update({'assets/snapshot.tar.xz': b'legacy'}),
                           lambda x: x.update({'lib/x86_64/unexpected.so': b'native'}),
                           lambda x: x.pop('assets/plugin-hard-manifest.json')]:
                make(change)
                with self.assertRaises((ValueError, KeyError)):
                    verify(apk)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--apk')
    parser.add_argument('--apk-dir')
    parser.add_argument('--out')
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(Controls)
        if not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful():
            raise SystemExit(1)
        return
    apks = [Path(args.apk)] if args.apk else list(Path(args.apk_dir or 'out').rglob('*.apk'))
    if len(apks) != 1 or not args.out:
        parser.error('require exactly one final APK and --out')
    result = verify(apks[0])
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + '\n')
    print('Linux payload identity verified: ' + str(apks[0]))


if __name__ == '__main__':
    main()
