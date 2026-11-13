#!/usr/bin/env python3
"""Create a Debian home seed from the factory home without Bionic modules or host paths."""
from pathlib import Path
import importlib.util
import json
import os
import shutil
import sys
import tarfile

_SPEC = importlib.util.spec_from_file_location('linux_abi', Path(__file__).with_name('linux-abi.py'))
_ABI = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_ABI)


def prepare(source, destination, canvas_archive, abi='arm64'):
    config = _ABI.linux_abi(abi)
    source, destination = Path(source), Path(destination)
    if destination.exists():
        raise ValueError('guest home stage already exists')
    home = destination / 'home'
    shutil.copytree(source, home, symlinks=True)
    for parent, dirs, files in os.walk(home, followlinks=False):
        for name in [*dirs, *files]:
            path = Path(parent) / name
            if path.is_symlink():
                target = os.readlink(path)
                for prefix in ('/data/data/com.snoworwind.pocketharness/files/usr/lib/node_modules', '/data/user/0/com.snoworwind.pocketharness/files/usr/lib/node_modules'):
                    if target.startswith(prefix):
                        path.unlink(); path.symlink_to('/opt/dsh' + target[len(prefix):]); break
        for name in files:
            path = Path(parent) / name
            if path.is_symlink() or path.suffix not in ('.yml', '.yaml', '.json', '.sh'):
                continue
            text = path.read_text()
            for prefix in ('/data/data/com.snoworwind.pocketharness/files/usr', '/data/user/0/com.snoworwind.pocketharness/files/usr'):
                text = text.replace(prefix + '/libexec/dsh-node', '/opt/node/bin/node')
                text = text.replace(prefix + '/bin/node', '/opt/node/bin/node')
                text = text.replace(prefix + '/bin/bash', '/bin/bash')
                text = text.replace(prefix + '/bin/python3', '/usr/bin/python3')
                text = text.replace(prefix, '/usr')
            text = text.replace(config['canvas_android'], config['canvas_binding'])
            path.write_text(text)
    for path in home.glob(f'.dsh/profiles/*/node_modules/{config["canvas_android"]}'):
        if path.is_symlink(): path.unlink()
        elif path.exists(): shutil.rmtree(path)
    profile = home / '.dsh/profiles/web/node_modules' / config['canvas_binding']
    profile.mkdir(parents=True, exist_ok=True)
    with tarfile.open(canvas_archive, 'r:gz') as archive:
        for member in archive:
            if not member.name.startswith('package/'):
                raise ValueError('unexpected canvas member')
            member.name = member.name[len('package/'):]
            if not member.name: continue
            archive.extract(member, profile, filter='data')
    # In this product the shell adapter name is historical, but its execution paths are Debian paths.
    return destination


if __name__ == '__main__':
    prepare(*sys.argv[1:])
