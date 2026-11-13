"""Package verified source-built Linux assets and an offline manifest; no network."""
import base64
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


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def package_assets(work, epoch):
    work = Path(work).resolve()
    if work != ROOT / '.deploy-tmp/linux-build':
        raise ValueError('Linux packaging requires the dedicated build directory')
    inputs = json.loads((ROOT / 'scripts/source-build/linux-inputs.json').read_text())
    stage = work / 'assets'
    stage.mkdir(parents=True, exist_ok=True)
    node_archive = work / 'input' / f'node-v{inputs["node"]}-linux-arm64.tar.xz'
    actual = sha256_file(node_archive)
    if actual != inputs['nodeSha256']:
        raise ValueError('official Node archive digest mismatch')
    node_source = work / 'node-source'
    if node_source.exists():
        shutil.rmtree(node_source)
    node_source.mkdir()
    with tarfile.open(node_archive, 'r:xz') as archive:
        if sys.version_info >= (3, 12):
            archive.extractall(node_source, filter='data')
        else:
            # Older local Python lacks tarfile's data filter. The archive is checked against the
            # source-pinned official Node SHA-256 above before this compatibility path is reachable.
            archive.extractall(node_source)
    original = node_source / f'node-v{inputs["node"]}-linux-arm64'
    node = work / 'node-stage'
    if node.exists():
        shutil.rmtree(node)
    (node / 'lib').mkdir(parents=True)
    shutil.copytree(original / 'bin', node / 'bin', symlinks=True)
    shutil.copytree(original / 'lib/node_modules', node / 'lib/node_modules', symlinks=True)
    shutil.copyfile(original / 'LICENSE', node / 'LICENSE')

    pnpm_archive = work / 'input/pnpm.tgz'
    with pnpm_archive.open('rb') as stream:
        integrity = 'sha512-' + base64.b64encode(hashlib.file_digest(stream, 'sha512').digest()).decode()
    if integrity != inputs['pnpm']['integrity']:
        raise ValueError('pinned pnpm archive integrity mismatch')
    pnpm = node / 'lib/node_modules/pnpm'
    pnpm.mkdir()
    with tarfile.open(pnpm_archive, 'r:gz') as archive:
        for member in archive:
            if not member.name.startswith('package/'):
                raise ValueError('unexpected pnpm archive path')
            member.name = member.name.removeprefix('package/')
            if member.name:
                archive.extract(member, pnpm, filter='data')
    package = json.loads((pnpm / 'package.json').read_text())
    if package.get('name') != 'pnpm' or package.get('version') != inputs['pnpm']['version']:
        raise ValueError('pnpm package identity mismatch')
    for name in ('pnpm', 'pnpx'):
        (node / 'bin' / name).unlink(missing_ok=True)
        (node / 'bin' / name).symlink_to(f'../lib/node_modules/pnpm/bin/{name}.cjs')

    def pack(directory, name):
        subprocess.run(['tar', '--sort=name', f'--mtime=@{int(epoch)}', '--owner=0', '--group=0', '--numeric-owner',
                        '-cJf', str(stage / name), '-C', str(directory), '.'], check=True)

    pack(node, f'node-glibc-v{inputs["node"]}-linux-arm64.tar.xz')
    manifest = dict(schemaVersion=1, runtime='linux-arm64-glibc', assets={})
    for name in ('debian-minimal-aarch64.tar.xz', f'node-glibc-v{inputs["node"]}-linux-arm64.tar.xz'):
        path = stage / name
        manifest['assets'][name] = dict(sha256=sha256_file(path), size=path.stat().st_size)
    (stage / 'linux-assets.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    package_assets(sys.argv[1], sys.argv[2])
