#!/usr/bin/env python3
"""Install the authenticated Canvas facade into the factory web profile."""
import importlib.util
import json
from pathlib import Path
import sys
import tarfile

_SPEC = importlib.util.spec_from_file_location('linux_abi', Path(__file__).with_name('linux-abi.py'))
_ABI = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_ABI)


def install(home, archive_path, version, abi='arm64'):
    config = _ABI.linux_abi(abi)
    profile = Path(home) / '.dsh/profiles/web'
    target = profile / 'node_modules/@napi-rs/canvas'
    target.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive_path, 'r:gz') as archive:
        for member in archive:
            if not member.name.startswith('package/'):
                raise ValueError('unexpected Canvas facade member')
            member.name = member.name[len('package/'):]
            if member.name:
                archive.extract(member, target, filter='data')
    manifest = json.loads((target / 'package.json').read_text())
    if manifest['name'] != '@napi-rs/canvas' or manifest['version'] != version:
        raise ValueError('Canvas facade identity mismatch')
    path = profile / 'package.json'
    factory = json.loads(path.read_text())
    factory.setdefault('dependencies', {}).update({'@napi-rs/canvas': version, config['canvas_binding']: version})
    path.write_text(json.dumps(factory, indent=2) + '\n')


if __name__ == '__main__':
    install(*sys.argv[1:])
