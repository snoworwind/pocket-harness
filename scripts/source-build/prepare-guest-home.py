#!/usr/bin/env python3
"""Create a Debian home seed from the factory home without Bionic modules or host paths."""
from pathlib import Path
import json
import os
import shutil
import sys
import tarfile


def prepare(source, destination, canvas_archive):
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
            text = text.replace('@napi-rs/canvas-android-arm64', '@napi-rs/canvas-linux-arm64-gnu')
            path.write_text(text)
    for path in home.glob('.dsh/profiles/*/node_modules/@napi-rs/canvas-android-arm64'):
        if path.is_symlink(): path.unlink()
        elif path.exists(): shutil.rmtree(path)
    profile = home / '.dsh/profiles/web/node_modules/@napi-rs/canvas-linux-arm64-gnu'
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
