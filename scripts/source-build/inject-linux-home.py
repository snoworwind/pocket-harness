#!/usr/bin/env python3
"""Install factory plugins into fresh Linux profiles, using the shared payload contract."""
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('plugin_payload', ROOT / 'scripts/inject-all.py')
payload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(payload)


def inject(root, repository=ROOT):
    root, repository = Path(root), Path(repository)
    manifest = json.loads((repository / 'scripts/plugin-dirs.json').read_text())
    scoped, external = [], []
    for directory in manifest['dirs']:
        path = repository / directory
        name = json.loads((path / 'package.json').read_text())['name']
        (scoped if name.startswith('@dsh-android/') else external).append(str(path))
    external += [str(repository / directory) for directory in manifest['externals']]
    packages = {f'@dsh-android/{name}': files for name, files in payload.build_dsh_replacements(scoped).items()}
    packages.update(payload.build_ext_replacements(external))
    patch = (repository / 'scripts/profile-web.cordis.patch.yml').read_text()
    for old in ('/data/user/0/com.snoworwind.pocketharness/files/usr', '/data/data/com.snoworwind.pocketharness/files/usr'):
        patch = patch.replace(old + '/libexec/dsh-node', '/opt/node/bin/node').replace(old, '/usr')
    for old in ('/data/user/0/com.snoworwind.pocketharness/files/home', '/data/data/com.snoworwind.pocketharness/files/home'):
        patch = patch.replace(old, '/home')
    for profile in ('web', 'headless'):
        target = root / 'home/.dsh/profiles' / profile
        if not (target / 'package.json').is_file():
            raise ValueError('factory profile missing: ' + profile)
        (target / 'cordis.patch.yml').write_text(patch)
        for name, files in packages.items():
            if name.startswith('/') or '..' in Path(name).parts:
                raise ValueError('unsafe package name')
            for relative, data in files.items():
                if Path(relative).is_absolute() or '..' in Path(relative).parts:
                    raise ValueError('unsafe plugin payload')
                destination = target / 'node_modules' / name / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
                destination.chmod(0o700 if data.startswith((b'#!', b'\x7fELF')) else 0o600)
    return sorted(packages)


if __name__ == '__main__':
    print(json.dumps(inject(sys.argv[1])))
