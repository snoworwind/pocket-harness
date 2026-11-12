#!/usr/bin/env python3
"""Cross-build node-pty for the glibc/aarch64 guest from pinned sources.

The Android engine tree ships a Bionic node-pty build. In the PRoot/Debian guest the
engine loads `node-pty` from the guest tree, so it needs a glibc/aarch64 build. Neither
npm nor the upstream tarball ships a linux prebuild, so it has to be compiled here with
the pinned headers and a cross toolchain.

Usage:
  python3 build-guest-node-pty.py --node-pty <tgz> --node-addon-api <tgz> \
      --headers <node-vX.Y.Z dir> --cc aarch64-linux-gnu-gcc --cxx aarch64-linux-gnu-g++ \
      --node <host node> --node-gyp <node-gyp.js> --out <dir>
  python3 build-guest-node-pty.py --self-test
"""
import argparse
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('build_guest_addons', HERE / 'build-guest-addons.py')
addons = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(addons)


def sha256_file(path):
    return addons.sha256_file(path)


def safe_extract(archive, destination):
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            target = destination / member.name
            if not str(target.resolve()).startswith(str(destination.resolve())):
                raise ValueError(f'archive entry escapes the destination: {member.name}')
            if member.issym() or member.islnk():
                raise ValueError(f'archive entry is a link: {member.name}')
        try:
            tar.extractall(destination, filter='data')
        except TypeError:
            # Python < 3.12 has no extraction filter; entries were validated above.
            tar.extractall(destination)


def build(tarball, napi_tarball, headers, cc, cxx, node, node_gyp, out, arch='arm64'):
    tarball, napi_tarball = Path(tarball).resolve(), Path(napi_tarball).resolve()
    headers = Path(headers).resolve()
    if not (headers / 'include/node/node_api.h').is_file():
        raise ValueError(f'Node-API headers missing under {headers}/include/node')
    if not Path(node).is_file():
        raise ValueError(f'host node is missing: {node}')
    if not Path(node_gyp).is_file():
        raise ValueError(f'node-gyp.js is missing: {node_gyp}')
    for tool in (cc, cxx):
        if shutil.which(tool) is None and not Path(tool).is_file():
            raise ValueError(f'cross compiler not found: {tool}')

    work = Path(tempfile.mkdtemp(prefix='guest-node-pty-'))
    try:
        safe_extract(tarball, work)
        roots = [entry for entry in work.iterdir() if entry.is_dir()]
        if len(roots) != 1:
            raise ValueError('node-pty archive must contain exactly one package directory')
        package = roots[0]
        napi_dir = work / 'napi'
        napi_dir.mkdir()
        safe_extract(napi_tarball, napi_dir)
        napi_roots = [entry for entry in napi_dir.iterdir() if entry.is_dir()]
        if len(napi_roots) != 1:
            raise ValueError('node-addon-api archive must contain exactly one package directory')
        modules = package / 'node_modules'
        modules.mkdir(exist_ok=True)
        shutil.copytree(napi_roots[0], modules / 'node-addon-api')

        environment = dict(
            PATH=f"{Path(cc).parent}:{Path(node).parent}:/usr/local/bin:/usr/bin:/bin",
            CC=str(cc), CXX=str(cxx),
            npm_config_arch=arch,
            npm_config_target=headers.name.removeprefix('node-'),
        )
        command = [str(node), str(node_gyp), 'rebuild', f'--arch={arch}', f'--nodedir={headers}']
        result = subprocess.run(command, cwd=package, env=environment, capture_output=True, text=True, timeout=1800)
        if result.returncode != 0:
            raise ValueError(f'node-gyp failed: {(result.stderr or result.stdout).strip()[-1200:]}')

        built = package / 'build/Release/pty.node'
        facts = addons.verify_addon(built, arch, allowed=addons.CPP_NEEDED)
        out = Path(out).resolve()
        out.mkdir(parents=True, exist_ok=True)
        shutil.copytree(package / 'lib', out / 'lib')
        (out / 'build/Release').mkdir(parents=True)
        shutil.copyfile(built, out / 'build/Release/pty.node')
        shutil.copytree(modules / 'node-addon-api', out / 'node_modules/node-addon-api')
        for name in ('package.json', 'LICENSE'):
            shutil.copyfile(package / name, out / name)
        receipt = dict(
            schemaVersion=1,
            abi=arch,
            target='glibc',
            package='node-pty',
            version=json.loads((package / 'package.json').read_text())['version'],
            sources=dict(
                nodePty=dict(sha256=sha256_file(tarball)),
                nodeAddonApi=dict(sha256=sha256_file(napi_tarball)),
                headers=dict(name=headers.name, nodeApiH=sha256_file(headers / 'include/node/node_api.h')),
            ),
            compiler=dict(cc=str(cc), cxx=str(cxx)),
            output=dict(path='build/Release/pty.node', **facts),
        )
        (out / 'guest-node-pty.json').write_text(json.dumps(receipt, indent=2) + '\n')
        return receipt
    finally:
        shutil.rmtree(work, ignore_errors=True)


def self_test():
    checks = []

    def expect(name, ok):
        checks.append((name, bool(ok)))

    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        archive = root / 'pkg.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            payload = root / 'payload.txt'
            payload.write_text('x')
            tar.add(payload, arcname='pkg/payload.txt')
        target = root / 'out'
        target.mkdir()
        safe_extract(archive, target)
        expect('extracts a well-formed archive', (target / 'pkg/payload.txt').is_file())

        escape = root / 'escape.tar.gz'
        with tarfile.open(escape, 'w:gz') as tar:
            payload.write_text('x')
            tar.add(payload, arcname='../escape.txt')
        try:
            safe_extract(escape, root / 'out2')
            expect('rejects an escaping entry', False)
        except ValueError:
            expect('rejects an escaping entry', True)

        try:
            build(root / 'missing.tgz', root / 'missing.tgz', root, 'cc', 'cxx', '/bin/true', '/bin/true', root / 'out')
            expect('rejects missing headers', False)
        except ValueError as error:
            expect('rejects missing headers', 'Node-API headers missing' in str(error))

    for name, ok in checks:
        print(('PASS ' if ok else 'FAIL ') + name)
    print(f'{len(checks)} checks passed')
    return 0 if all(ok for _, ok in checks) else 1


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    for name in ('node-pty', 'node-addon-api', 'headers', 'cc', 'cxx', 'node', 'node-gyp', 'out'):
        parser.add_argument('--' + name)
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    missing = [name for name in ('node_pty', 'node_addon_api', 'headers', 'cc', 'cxx', 'node', 'node_gyp', 'out')
               if not getattr(args, name.replace('-', '_'))]
    if missing:
        parser.error('missing required arguments: ' + ', '.join('--' + name.replace('_', '-') for name in missing))
    try:
        receipt = build(args.node_pty, args.node_addon_api, args.headers, args.cc, args.cxx,
                        args.node, args.node_gyp, args.out)
    except ValueError as error:
        print(f'FAIL {error}', file=sys.stderr)
        return 1
    print(json.dumps(receipt['output'], ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
