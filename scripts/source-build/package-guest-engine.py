#!/usr/bin/env python3
"""Assemble the glibc/aarch64 engine tree from the Android engine tree.

The shipped engine tree is assembled on a host for Android/Bionic: it carries
android/darwin/win32 native prebuilds and none of the glibc addons. A PRoot/Debian
guest loads `process.platform === 'linux'` variants, so the tree has to be rewritten:

  * keep the JavaScript packages (platform independent),
  * drop every non-linux-arm64 native prebuild,
  * keep the npm-provided glibc/aarch64 packages (node-pty prebuild, node-addon-system).

Usage:
  python3 package-guest-engine.py --tree <node_modules> --node-pty <dir> \
      --addon <dir> --out <dir> [--epoch <unix>]
  python3 package-guest-engine.py --self-test
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRUNE_DIRS = ('darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'android-arm64', 'android-x64', 'linux-x64')
ADDON_PACKAGE = '@deepseek-ai/node-addon-system-linux-arm64'


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def count_files(root):
    total = 0
    for _, _, files in os.walk(root):
        total += len(files)
    return total


def _is_pruned_dir(path):
    name = path.name
    if name in PRUNE_DIRS and path.parent.name == 'prebuilds':
        return True
    # Android/macOS/Windows native packages never load in the guest.
    if name.startswith(('canvas-android-', 'canvas-darwin-', 'canvas-win32-')):
        return True
    if name.startswith('koffi-android-'):
        return True
    if name.startswith(('koffi-linux-x64', 'koffi-darwin-', 'koffi-win32-')):
        return True
    return False


def copy_engine_tree(tree, out):
    """Copy the engine tree, preserving (even dangling) pnpm symlinks and pruning variants."""
    removed = []

    def copy_entry(src, dst):
        if src.is_symlink():
            os.symlink(os.readlink(src), dst)
            return
        if src.is_dir():
            if _is_pruned_dir(src):
                removed.append(str(dst.relative_to(out)))
                return
            dst.mkdir(exist_ok=True)
            for child in src.iterdir():
                copy_entry(child, dst / child.name)
            return
        shutil.copy2(src, dst)

    out.mkdir(parents=True, exist_ok=True)
    for child in Path(tree).iterdir():
        copy_entry(child, out / child.name)
    return removed


def install_node_pty(root, node_pty):
    if node_pty is None:
        # npm 包自带 prebuilds/linux-arm64；客体树保留它即可，不再自编译。
        return dict(package='node-pty', pty='package-manager', state='from-npm-prebuilds')
    node_pty = Path(node_pty)
    pty_dirs = list(root.glob('@deepseek-ai/dsh/node_modules/.pnpm/node-pty@*/node_modules/node-pty'))
    if len(pty_dirs) != 1:
        raise ValueError(f'expected exactly one node-pty package, found {len(pty_dirs)}')
    target = pty_dirs[0]
    prebuild = target / 'prebuilds/linux-arm64/pty.node'
    prebuild.parent.mkdir(parents=True, exist_ok=True)
    built = node_pty / 'build/Release/pty.node'
    if not built.is_file():
        raise ValueError(f'node-pty build output missing: {built}')
    shutil.copyfile(built, prebuild)
    # node-pty's runtime needs node-addon-api next to it when it is loaded from source.
    napi = node_pty / 'node_modules/node-addon-api'
    if napi.is_dir():
        destination = target / 'node_modules/node-addon-api'
        shutil.rmtree(destination, ignore_errors=True)
        shutil.copytree(napi, destination, symlinks=True)
    return dict(package=str(target.relative_to(root)), pty=sha256_file(prebuild), state='built-from-source')


def install_system_addon(root, addon):
    if addon is None:
        return dict(package=ADDON_PACKAGE, system='package-manager', state='from-npm-package')
    addon = Path(addon)
    source = addon / 'bin/glibc/system.node'
    if not source.is_file():
        raise ValueError(f'guest addon binary missing: {source}')
    destination = root / '@deepseek-ai/dsh/node_modules' / ADDON_PACKAGE
    shutil.rmtree(destination, ignore_errors=True)
    shutil.copytree(addon, destination, symlinks=True)
    return dict(package=ADDON_PACKAGE, system=sha256_file(destination / 'bin/glibc/system.node'))


def write_archive(root, archive, epoch=None):
    """Deterministic xz archive without depending on GNU tar flags."""
    def scrub(info):
        info.uid = 0
        info.gid = 0
        info.uname = ''
        info.gname = ''
        if epoch is not None:
            info.mtime = int(epoch)
        return info

    with tarfile.open(archive, 'w:xz') as tar:
        for path in sorted(Path(root).rglob('*'), key=lambda item: str(item.relative_to(root))):
            tar.add(path, arcname=str(Path('.') / path.relative_to(root)), recursive=False, filter=scrub)


def assemble(tree, node_pty, addon, out, epoch=None):
    tree = Path(tree).resolve()
    if not (tree / '@deepseek-ai/dsh/lib/bin.js').is_file():
        raise ValueError('engine tree is missing @deepseek-ai/dsh/lib/bin.js')
    out = Path(out).resolve()
    if out.exists():
        shutil.rmtree(out)
    removed = copy_engine_tree(tree, out)
    pty = install_node_pty(out, node_pty)
    system = install_system_addon(out, addon)
    receipt = dict(
        schemaVersion=1,
        target=dict(os='linux', cpu='arm64', libc='glibc'),
        files=count_files(out),
        pruned=removed,
        nodePty=pty,
        systemAddon=system,
        addon=dict(path=ADDON_PACKAGE, sha256=system['system']),
        scope='JavaScript packages are host-independent; native prebuilds are replaced for glibc/aarch64',
    )
    (out.parent / 'engine-glibc.json').write_text(json.dumps(receipt, indent=2) + '\n')
    archive = out.parent / 'engine-glibc.tar.xz'
    write_archive(out, archive, epoch)
    receipt['archive'] = dict(name=archive.name, size=archive.stat().st_size, sha256=sha256_file(archive))
    (out.parent / 'engine-glibc.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def self_test():
    checks = []

    def expect(name, ok):
        checks.append((name, bool(ok)))

    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        tree = root / 'tree'
        pty_dir = tree / '@deepseek-ai/dsh/node_modules/.pnpm/node-pty@1.0.0/node_modules/node-pty/prebuilds'
        for variant in ('android-arm64', 'linux-arm64', 'win32-x64'):
            (pty_dir / variant).mkdir(parents=True)
            (pty_dir / variant / 'pty.node').write_bytes(variant.encode())
        (tree / '@deepseek-ai/dsh/lib').mkdir(parents=True)
        os.symlink('../missing-pruned-package', tree / '@deepseek-ai/dsh/lib/dangling-link')
        (tree / '@deepseek-ai/dsh/lib/bin.js').write_text('// bin')
        pty = root / 'pty'
        (pty / 'build/Release').mkdir(parents=True)
        (pty / 'build/Release/pty.node').write_bytes(b'glibc-pty')
        (pty / 'node_modules/node-addon-api').mkdir(parents=True)
        addon = root / 'addon'
        (addon / 'bin/glibc').mkdir(parents=True)
        (addon / 'bin/glibc/system.node').write_bytes(b'glibc-addon')
        receipt = assemble(tree, pty, addon, root / 'out')
        expect('android prebuild pruned', not (root / 'out/@deepseek-ai/dsh/node_modules/.pnpm/node-pty@1.0.0/node_modules/node-pty/prebuilds/android-arm64').exists())
        expect('linux prebuild kept', (root / 'out/@deepseek-ai/dsh/node_modules/.pnpm/node-pty@1.0.0/node_modules/node-pty/prebuilds/linux-arm64/pty.node').read_bytes() == b'glibc-pty')
        expect('system addon installed', (root / 'out' / '@deepseek-ai/dsh/node_modules' / ADDON_PACKAGE / 'bin/glibc/system.node').is_file())
        expect('archive produced and hashed', receipt['archive']['size'] > 0 and len(receipt['archive']['sha256']) == 64)
        expect('dangling pnpm link preserved', (root / 'out/@deepseek-ai/dsh/lib/dangling-link').is_symlink())

        (tree / '@deepseek-ai/dsh/lib/bin.js').unlink()
        try:
            assemble(tree, pty, addon, root / 'out2')
            expect('rejects a tree without the engine entry', False)
        except ValueError:
            expect('rejects a tree without the engine entry', True)

    for name, ok in checks:
        print(('PASS ' if ok else 'FAIL ') + name)
    print(f'{len(checks)} checks passed')
    return 0 if all(ok for _, ok in checks) else 1


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--tree')
    parser.add_argument('--node-pty')
    parser.add_argument('--addon')
    parser.add_argument('--out')
    parser.add_argument('--epoch', type=int)
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    if not all([args.tree, args.out]):
        parser.error('--tree and --out are required')
    try:
        receipt = assemble(args.tree, args.node_pty, args.addon, args.out, args.epoch)
    except ValueError as error:
        print(f'FAIL {error}', file=sys.stderr)
        return 1
    print(json.dumps(receipt['archive'], ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
