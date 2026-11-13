#!/usr/bin/env python3
"""Verify the final APK's Linux assets against their manifest, without extraction."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tempfile
import unittest
import zipfile
import importlib.util

_spec = importlib.util.spec_from_file_location('linux_abi', Path(__file__).with_name('linux-abi.py'))
_abi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_abi)

PAYLOADS = ('rootfs', 'node', 'engine', 'home')


def verify(apk, abi='arm64'):
    config = _abi.linux_abi(abi)
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        for name in names:
            if '\\' in name or name.startswith('/') or '..' in PurePosixPath(name).parts or str(PurePosixPath(name)) != name.rstrip('/'):
                raise ValueError('unsafe APK member: ' + name)
        if not {'AndroidManifest.xml', 'classes.dex'}.issubset(names):
            raise ValueError('missing Android executable payload')
        if len(names) != len(set(names)):
            raise ValueError('duplicate APK member')
        if any(name in names for name in ('assets/snapshot.tar.xz', 'assets/snapshot.sha256')):
            raise ValueError('legacy runtime snapshot in Linux APK')
        if archive.getinfo('assets/linux/manifest.json').file_size > 64 * 1024:
            raise ValueError('oversized Linux manifest')
        raw = archive.read('assets/linux/manifest.json')
        manifest = json.loads(raw)
        if manifest.get('schemaVersion') != 1 or manifest.get('guestArchitecture') != config['legacy']:
            raise ValueError('unsupported Linux instance schema or ABI')
        expected_linux = {'assets/linux/manifest.json', *(f'assets/linux/{name}.tar.xz' for name in PAYLOADS)}
        if {name for name in names if name.startswith('assets/linux/') and not name.endswith('/')} != expected_linux:
            raise ValueError('unexpected or missing Linux APK assets')
        for key in ('rootfsTreeSha256', 'nodeTreeSha256', 'engineTreeSha256', 'homeSchemaVersion', 'baseId', 'minimumGlibc'):
            if not manifest.get(key):
                raise ValueError('missing Linux manifest field: ' + key)
        for name in PAYLOADS:
            for suffix in (['Sha256', 'TreeSha256'] if name != 'home' else ['Sha256']):
                if not re.fullmatch('[a-f0-9]{64}', str(manifest.get(name + suffix, ''))):
                    raise ValueError('invalid Linux payload digest field: ' + name + suffix)
            digest = hashlib.sha256()
            with archive.open(f'assets/linux/{name}.tar.xz') as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            if digest.hexdigest() != manifest.get(name + 'Sha256'):
                raise ValueError('Linux payload digest mismatch: ' + name)
        hard = json.loads(archive.read('assets/plugin-hard-manifest.json'))
        if hard.get('schema') != 2 or hard.get('complete') is not True or not hard.get('entries'):
            raise ValueError('missing complete plugin ownership manifest')
        native = sorted(name for name in names if name.startswith('lib/') and not name.endswith('/'))
        for name in ('libpocketharness_terminal.so', 'libpocketharness_proot.so'):
            if f"lib/{config['android_abi']}/{name}" not in native:
                raise ValueError('missing required host native library: ' + name)
        if any(not name.startswith(f"lib/{config['android_abi']}/") for name in native):
            raise ValueError('unexpected host ABI in Linux APK')
        return dict(schemaVersion=1, mode='linux-guest', abi=abi, runtime=config['runtime'], bundledTermuxSnapshot=False,
                    manifestSha256=hashlib.sha256(raw).hexdigest(), manifest=manifest,
                    assets=sorted(name for name in names if name.startswith('assets/')), nativeLibraries=native)


class Controls(unittest.TestCase):
    def test_valid_and_negative_controls(self):
        for abi in _abi.ABIS:
            config = _abi.linux_abi(abi)
            with tempfile.TemporaryDirectory() as temporary:
                apk = Path(temporary) / 'fixture.apk'
                manifest = dict(schemaVersion=1, guestArchitecture=config['legacy'], homeSchemaVersion=2,
                                baseId='fixture', minimumGlibc='2.41', rootfsTreeSha256='a'*64,
                                nodeTreeSha256='b'*64, engineTreeSha256='c'*64)
                for name in PAYLOADS:
                    manifest[name + 'Sha256'] = hashlib.sha256(name.encode()).hexdigest()
                other_abi = 'x86_64' if abi == 'arm64' else 'arm64-v8a'
                def make(change=None):
                    values = {'AndroidManifest.xml': b'manifest', 'classes.dex': b'dex', 'assets/linux/manifest.json': json.dumps(manifest),
                              'assets/plugin-hard-manifest.json': json.dumps(dict(schema=2, complete=True, entries=[{'name': 'fixture'}])),
                              f"lib/{config['android_abi']}/libpocketharness_terminal.so": b'native',
                              f"lib/{config['android_abi']}/libpocketharness_proot.so": b'native'}
                    values.update({f'assets/linux/{name}.tar.xz': name.encode() for name in PAYLOADS})
                    if change:
                        change(values)
                    with zipfile.ZipFile(apk, 'w') as archive:
                        for name, data in values.items():
                            archive.writestr(name, data)
                make()
                self.assertEqual(verify(apk, abi)['mode'], 'linux-guest')
                for change in [lambda x: x.update({'assets/linux/engine.tar.xz': b'tampered'}),
                               lambda x: x.pop('assets/linux/node.tar.xz'),
                               lambda x: x.update({'assets/snapshot.tar.xz': b'legacy'}),
                               lambda x: x.update({f'lib/{other_abi}/unexpected.so': b'native'}),
                               lambda x: x.pop('assets/plugin-hard-manifest.json'),
                               lambda x: x.update({'../escaped': b'bad'}),
                               lambda x: x.update({'assets/linux/extra': b'bad'}),
                               lambda x: x.pop('classes.dex')]:
                    make(change)
                    with self.assertRaises((ValueError, KeyError)):
                        verify(apk, abi)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--apk')
    parser.add_argument('--apk-dir')
    parser.add_argument('--out')
    parser.add_argument('--abi', default='arm64', choices=_abi.ABIS)
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(Controls)
        if not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful():
            raise SystemExit(1)
        return
    apks = [Path(args.apk)] if args.apk else list(Path(args.apk_dir or 'out').rglob('*.apk'))
    if len(apks) != 1 or not args.out:
        parser.error('require exactly one final APK and --out')
    result = verify(apks[0], args.abi)
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + '\n')
    print('Linux payload identity verified: ' + str(apks[0]))


if __name__ == '__main__':
    main()
