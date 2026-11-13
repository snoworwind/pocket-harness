"""Package verified source-built Linux assets and an offline manifest; no network."""
import argparse
import base64
import hashlib
import importlib.util
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


def _load_linux_abi():
    path = Path(__file__).with_name('linux-abi.py')
    spec = importlib.util.spec_from_file_location('pocket_harness_linux_abi', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_LINUX_ABI = _load_linux_abi()
ABIS = _LINUX_ABI.ABIS


def linux_abi(value='arm64'):
    return _LINUX_ABI.linux_abi(value)


def node_digest(inputs, mapping):
    key = 'nodeSha256' if mapping['abi'] == 'arm64' else 'nodeSha256X64'
    digest = inputs.get(key)
    if not digest:
        raise ValueError(f'linux-inputs.json is missing the pinned Node digest for {mapping["abi"]}')
    return digest


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def package_assets(work, epoch, abi='arm64'):
    mapping = linux_abi(abi)
    work = Path(work).resolve()
    if work != ROOT / '.deploy-tmp/linux-build':
        raise ValueError('Linux packaging requires the dedicated build directory')
    inputs = json.loads((ROOT / 'scripts/source-build/linux-inputs.json').read_text())
    stage = work / 'assets'
    stage.mkdir(parents=True, exist_ok=True)
    node_archive = work / 'input' / f'node-v{inputs["node"]}-{mapping["node_platform"]}.tar.xz'
    actual = sha256_file(node_archive)
    if actual != node_digest(inputs, mapping):
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
    original = node_source / f'node-v{inputs["node"]}-{mapping["node_platform"]}'
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

    node_name = f'node-glibc-v{inputs["node"]}-{mapping["node_platform"]}.tar.xz'
    pack(node, node_name)
    manifest = dict(schemaVersion=1, runtime=mapping['runtime'], assets={})
    for name in (mapping['rootfs_asset'], node_name):
        path = stage / name
        manifest['assets'][name] = dict(sha256=sha256_file(path), size=path.stat().st_size)
    (stage / 'linux-assets.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('work')
    parser.add_argument('epoch')
    parser.add_argument('--abi', default='arm64', choices=ABIS)
    args = parser.parse_args(argv)
    package_assets(args.work, args.epoch, args.abi)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
