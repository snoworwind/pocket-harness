"""Copy notices for the platform-resolved Cargo build dependency graph."""
import json
from pathlib import Path
import shutil
import sys

MAX_LICENSE_BYTES = 2 * 1024**2
LICENSE_PREFIXES = ('LICENSE', 'LICENCE', 'COPYING', 'NOTICE')


def reachable_packages(metadata):
    """Return packages reachable from Cargo's filtered target resolve graph.

    Cargo must be invoked with --filter-platform for the actual binary target.
    Dev-only edges are excluded; normal and build dependencies are shipped or
    run as part of producing that target and therefore retain their notices.
    """
    resolve = metadata.get('resolve')
    if not isinstance(resolve, dict) or not isinstance(resolve.get('nodes'), list):
        raise ValueError('Cargo metadata must contain a resolved dependency graph')
    nodes = {node['id']: node for node in resolve['nodes']}
    roots = [resolve['root']] if resolve.get('root') else metadata.get('workspace_members', [])
    if not roots or any(root not in nodes for root in roots):
        raise ValueError('Cargo metadata has no resolvable workspace root')

    reachable = set()
    pending = list(roots)
    while pending:
        package_id = pending.pop()
        if package_id in reachable:
            continue
        node = nodes.get(package_id)
        if node is None:
            raise ValueError('Cargo dependency graph references an unknown package')
        reachable.add(package_id)
        for dependency in node.get('deps', []):
            kinds = dependency.get('dep_kinds') or [{'kind': None}]
            if any(kind.get('kind') in (None, 'normal', 'build') for kind in kinds):
                pending.append(dependency['pkg'])

    packages = {package['id']: package for package in metadata.get('packages', [])}
    if any(package_id not in packages for package_id in reachable):
        raise ValueError('Cargo resolve graph package metadata is incomplete')
    return sorted((packages[package_id] for package_id in reachable),
                  key=lambda package: (package['name'], package['version'], package['id']))


def package_licenses(package):
    root = Path(package['manifest_path']).parent.resolve(strict=True)
    candidates = []
    for child in root.iterdir():
        if child.name.upper().startswith(LICENSE_PREFIXES):
            if child.is_symlink():
                raise ValueError('license symlink is forbidden: ' + package['name'])
            if child.is_file():
                candidates.append(child)
            elif child.is_dir() and child.name.upper().startswith(('LICENSES', 'LICENCES')):
                for path in child.rglob('*'):
                    if path.is_symlink():
                        raise ValueError('nested license symlink is forbidden: ' + package['name'])
                    if path.is_file():
                        candidates.append(path)

    if package.get('license_file'):
        declared = root / package['license_file']
        if declared.is_symlink():
            raise ValueError('declared license symlink is forbidden: ' + package['name'])
        path = declared.resolve(strict=True)
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError('crate license escapes source root')
        if path not in candidates:
            candidates.append(path)

    # Keep relative paths so several license texts with the same basename do
    # not overwrite each other and the inventory identifies each notice.
    unique = {path.relative_to(root).as_posix(): path for path in candidates}
    if not unique:
        raise ValueError('missing native dependency license: ' + package['name'])
    for relative, path in unique.items():
        if path.stat().st_size > MAX_LICENSE_BYTES:
            raise ValueError('license file is unexpectedly large: ' + package['name'] + '/' + relative)
    return root, sorted(unique.items())


def collect(metadata, destination):
    destination = Path(destination)
    if destination.is_symlink():
        raise ValueError('license destination cannot be a symlink')
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    inventory = []
    for package in reachable_packages(metadata):
        root, files = package_licenses(package)
        target = destination / (package['name'] + '-' + package['version'])
        for relative, source in files:
            output = target / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, output)
        inventory.append(dict(name=package['name'], version=package['version'], license=package.get('license'),
                              files=[relative for relative, _ in files]))
    (destination / 'inventory.json').write_text(json.dumps(inventory, indent=2) + '\n', encoding='utf-8')
    return inventory


if __name__ == '__main__':
    metadata = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    collect(metadata, sys.argv[2])
