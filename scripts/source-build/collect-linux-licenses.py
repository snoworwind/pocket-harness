"""Copy native dependency notices from cargo's checksum-verified source cache."""
import json
from pathlib import Path
import shutil
import sys

metadata = json.loads(Path(sys.argv[1]).read_text())
destination = Path(sys.argv[2])
destination.mkdir(parents=True, exist_ok=True)
inventory = []
for package in sorted(metadata['packages'], key=lambda p: (p['name'], p['version'])):
    root = Path(package['manifest_path']).parent.resolve()
    files = [p for p in root.iterdir() if p.is_file() and not p.is_symlink() and p.name.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE'))]
    if package.get('license_file'):
        path = (root / package['license_file']).resolve()
        if not path.is_relative_to(root):
            raise ValueError('crate license escapes source root')
        if path not in files:
            files.append(path)
    if not files:
        raise ValueError('missing native dependency license: ' + package['name'])
    target = destination / (package['name'] + '-' + package['version'])
    target.mkdir(exist_ok=True)
    for path in files:
        if path.stat().st_size > 2 * 1024**2:
            raise ValueError('license file is unexpectedly large')
        shutil.copyfile(path, target / path.name)
    inventory.append(dict(name=package['name'], version=package['version'], license=package.get('license'), files=sorted(p.name for p in files)))
(destination / 'inventory.json').write_text(json.dumps(inventory, indent=2) + '\n')
