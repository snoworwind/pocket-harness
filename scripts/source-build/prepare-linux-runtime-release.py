#!/usr/bin/env python3
"""Verify an already published source release's Linux assets for its versioned download release."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest
from urllib.parse import urlparse


def prepare(source, output, repository, commit):
    source, output = Path(source), Path(output)
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repository) or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('invalid source repository or commit')
    entries = list(source.iterdir())
    if any(p.is_symlink() or not p.is_file() for p in entries):
        raise ValueError('release inputs must be regular files')
    body = (source / 'linux-release.json').read_bytes()
    digest = hashlib.sha256(body).hexdigest()
    if (source / 'linux-runtime-manifest.sha256').read_text().strip() != digest:
        raise ValueError('manifest digest mismatch')
    manifest = json.loads(body)
    version = manifest['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version) or len(manifest['runtimes']) != 1:
        raise ValueError('invalid runtime version or runtime set')
    runtime = manifest['runtimes'][0]
    assets = [manifest['plugins']['bootstrap'], manifest['plugins']['runtime'],
              runtime['backendAsset'], runtime['rootfsAsset'], runtime['nodeAsset']]
    expected = {'linux-release.json', 'linux-runtime-manifest.sha256'}
    for asset in assets:
        url = urlparse(asset['url'])
        name = Path(url.path).name
        if (url.scheme != 'https' or url.netloc != 'github.com' or url.query or url.fragment
                or url.path != f'/{repository}/releases/download/v{version}/{name}'
                or not re.fullmatch(r'[A-Za-z0-9._-]+\.tar\.xz', name) or name in expected):
            raise ValueError('asset URL does not match the versioned release')
        payload = (source / name).read_bytes()
        if len(payload) != asset['size'] or hashlib.sha256(payload).hexdigest() != asset['sha256']:
            raise ValueError('asset digest or size mismatch')
        expected.add(name)
    if {p.name for p in entries} != expected:
        raise ValueError('missing or unexpected runtime release asset')
    output.mkdir(parents=True, exist_ok=False)
    for name in sorted(expected):
        shutil.copyfile(source / name, output / name)
    (output / 'target.json').write_text(json.dumps(dict(tag='v' + version, commit=commit, repository=repository)))
    (output / 'SHA256SUMS.txt').write_text(''.join(
        hashlib.sha256((output / name).read_bytes()).hexdigest() + '  ' + name + '\n' for name in sorted(expected)))


class ReleaseTests(unittest.TestCase):
    def test_verified_release_and_controlled_negatives(self):
        for mode in ['valid', 'digest', 'url', 'extra', 'missing']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                source, output = Path(directory) / 'source', Path(directory) / 'out'
                source.mkdir()
                rows = []
                for i in range(5):
                    name = f'asset-{i}.tar.xz'
                    (source / name).write_bytes(b'payload')
                    rows.append(dict(url=f'https://github.com/fixture/repo/releases/download/v0.15.3/{name}',
                                     size=7, sha256=hashlib.sha256(b'payload').hexdigest()))
                if mode == 'url': rows[0]['url'] = rows[0]['url'].replace('fixture/repo', 'other/repo')
                manifest = dict(version='0.15.3', plugins=dict(bootstrap=rows[0], runtime=rows[1]),
                                runtimes=[dict(backendAsset=rows[2], rootfsAsset=rows[3], nodeAsset=rows[4])])
                body = json.dumps(manifest).encode()
                (source / 'linux-release.json').write_bytes(body)
                (source / 'linux-runtime-manifest.sha256').write_text(hashlib.sha256(body).hexdigest())
                if mode == 'digest': (source / 'asset-0.tar.xz').write_bytes(b'poison!')
                if mode == 'missing': (source / 'asset-0.tar.xz').unlink()
                if mode == 'extra': (source / 'extra').write_text('unreviewed')
                if mode == 'valid':
                    prepare(source, output, 'fixture/repo', 'a' * 40)
                    self.assertEqual(json.loads((output / 'target.json').read_text())['tag'], 'v0.15.3')
                else:
                    with self.assertRaises((ValueError, FileNotFoundError)):
                        prepare(source, output, 'fixture/repo', 'a' * 40)
                    self.assertFalse(output.exists())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source', 'output', 'repository', 'commit']: parser.add_argument(name, nargs='?')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ReleaseTests))
        raise SystemExit(0 if result.wasSuccessful() else 1)
    prepare(args.source, args.output, args.repository, args.commit)
