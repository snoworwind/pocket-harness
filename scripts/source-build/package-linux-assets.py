"""Package verified source-built Linux assets and an offline manifest; no network."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]


def package_assets(work, epoch):
    work = Path(work).resolve()
    if work != ROOT / '.deploy-tmp/linux-build':
        raise ValueError('Linux packaging requires the dedicated build directory')
    inputs = json.loads((ROOT / 'scripts/source-build/linux-inputs.json').read_text())
    stage = work / 'assets'
    stage.mkdir(parents=True, exist_ok=True)
    node_archive = work / 'input' / f'node-v{inputs["node"]}-linux-arm64.tar.xz'
    with node_archive.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual != inputs['nodeSha256']:
        raise ValueError('official Node archive digest mismatch')
    node_source = work / 'node-source'
    if node_source.exists():
        shutil.rmtree(node_source)
    node_source.mkdir()
    with tarfile.open(node_archive, 'r:xz') as archive:
        archive.extractall(node_source, filter='data')
    original = node_source / f'node-v{inputs["node"]}-linux-arm64'
    node = work / 'node-stage'
    if node.exists():
        shutil.rmtree(node)
    (node / 'lib').mkdir(parents=True)
    shutil.copytree(original / 'bin', node / 'bin', symlinks=True)
    shutil.copytree(original / 'lib/node_modules', node / 'lib/node_modules', symlinks=True)
    shutil.copyfile(original / 'LICENSE', node / 'LICENSE')

    def pack(directory, name):
        subprocess.run(['tar', '--sort=name', f'--mtime=@{int(epoch)}', '--owner=0', '--group=0', '--numeric-owner',
                        '-cJf', str(stage / name), '-C', str(directory), '.'], check=True)

    pack(node, f'node-glibc-v{inputs["node"]}-linux-arm64.tar.xz')
    for package in ['linux-runtime', 'linux-bootstrap']:
        target = work / package
        if target.exists():
            shutil.rmtree(target)
        target.mkdir()
        if package == 'linux-runtime':
            source = ROOT / 'vendor/dsh-linux-runtime'
            for path in ['lib', 'modules']:
                shutil.copytree(source / path, target / path)
            for path in ['package.json', 'LICENSE']:
                shutil.copyfile(source / path, target / path)
        else:
            source = ROOT / 'plugins/dsh-linux-bootstrap'
            shutil.copytree(source / 'src', target / 'lib')
            shutil.copytree(source / 'src', target / 'src')
            shutil.copytree(source / 'client', target / 'client')
            shutil.copyfile(source / 'package.json', target / 'package.json')
            shutil.copyfile(ROOT / 'vendor/bionilux/LICENSE', target / 'LICENSE')
        pack(target, package + '-plugin.tar.xz')

    repository = os.environ.get('GITHUB_REPOSITORY')
    if not repository:
        url = os.environ.get('DSH_SOURCE_REPOSITORY') or subprocess.check_output(['git', 'remote', 'get-url', 'origin'], cwd=ROOT, text=True).strip()
        repository = urlparse(url).path.strip('/').removesuffix('.git')
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repository):
        raise ValueError('invalid source repository')
    # URLs are stable, opaque identifiers. The host serves these bytes locally;
    # the offline adapter never performs a GitHub request (the repo is private).
    base = f'https://github.com/{repository}/releases/download/v{inputs["runtimeVersion"]}'

    def describe(name):
        path = stage / name
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        with tarfile.open(path, 'r:xz') as archive:
            size = sum(item.size for item in archive if item.isfile())
        if size <= 0:
            raise ValueError('empty Linux archive: ' + name)
        return dict(url=base + '/' + name, sha256=digest, size=path.stat().st_size, unpackedSize=size)

    manifest = dict(schemaVersion=1, version=inputs['runtimeVersion'], minMobileVersion=inputs['minimumAppVersion'],
                    plugins=dict(bootstrap=describe('linux-bootstrap-plugin.tar.xz'), runtime=describe('linux-runtime-plugin.tar.xz')),
                    runtimes=[dict(id='debian-minimal', label='Debian 13 ARM64', architecture='arm64', backend='bionilux',
                                   backendAsset=describe('bionilux-backend-aarch64.tar.xz'),
                                   rootfsAsset=describe('debian-minimal-aarch64.tar.xz'),
                                   nodeAsset=describe(f'node-glibc-v{inputs["node"]}-linux-arm64.tar.xz'))])
    body = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    (stage / 'linux-release.json').write_bytes(body)
    (stage / 'linux-runtime-manifest.sha256').write_text(hashlib.sha256(body).hexdigest() + '\n')
    return manifest


if __name__ == '__main__':
    package_assets(sys.argv[1], sys.argv[2])
