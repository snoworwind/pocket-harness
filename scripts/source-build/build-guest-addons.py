#!/usr/bin/env python3
"""Build guest (linux-arm64/glibc) Node-API addons from the pinned harness source.

Why this exists: the Android engine tree is assembled on a linux-x64 build host, so
pnpm drops every `native/*/packages/linux-*` optional dependency before the snapshot
is packed. A Debian/glibc guest therefore has no addon binaries at all. Option B of
the P2/P3 audit is to rebuild those addons for the guest target from the same pinned
harness source instead of shipping the dropped prebuilds.

This script only builds what the pinned source can build in-tree:
`@deepseek-ai/node-addon-system` -> `flock.c` (Node-API 8, glibc, aarch64).
The static-musl `landlock-run` launcher needs a musl cross toolchain and is recorded
as an explicit gap rather than silently skipped.

Usage:
  python3 build-guest-addons.py --harness <checkout> --headers <node headers> \
      --cc aarch64-linux-gnu-gcc --out <dir> [--abi arm64]
  python3 build-guest-addons.py --self-test
"""
import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from importlib import import_module  # noqa: E402

native = import_module('inventory-native-runtime')

ADDON_SOURCE = Path('native/system/packages/entry/src/flock.c')
EXPECTED_MACHINE = {'arm64': 183, 'x86_64': 62}
ALLOWED_NEEDED = {'libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'ld-linux-aarch64.so.1'}


def sha256_file(path):
    return native.sha256_file(Path(path))


def compiler_identity(cc):
    path = shutil.which(cc) or (cc if Path(cc).is_file() else None)
    if not path:
        raise ValueError(f'cross compiler not found: {cc}')
    resolved = Path(path).resolve()
    result = subprocess.run([str(resolved), '--version'], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise ValueError(f'cross compiler is not runnable: {cc}')
    return dict(path=str(resolved), version=result.stdout.splitlines()[0], sha256=sha256_file(resolved))


def read_headers(path):
    header = Path(path) / 'node_api.h'
    if not header.is_file():
        raise ValueError(f'Node-API headers missing: {header}')
    return dict(path=str(Path(path).resolve()), nodeApiH=sha256_file(header))


def verify_addon(path, abi='arm64'):
    """Reject anything that is not a shared linux/<abi> Node-API addon."""
    data = Path(path).read_bytes()
    meta = native.elf_metadata(data)
    if meta['type'] != 3:
        raise ValueError(f'addon is not a shared object (ELF type {meta["type"]})')
    if meta['machine'] != EXPECTED_MACHINE[abi]:
        raise ValueError(f'addon machine {meta["machine"]} does not match {abi}')
    if meta.get('interpreter'):
        raise ValueError('addon unexpectedly declares a program interpreter')
    unexpected = [name for name in meta.get('needed', []) if name not in ALLOWED_NEEDED]
    if unexpected:
        raise ValueError(f'addon links unexpected libraries: {", ".join(unexpected)}')
    return dict(
        bits=meta['bits'],
        architecture=meta['architecture'],
        type=meta['type'],
        needed=meta.get('needed', []),
        soname=meta.get('soname', []),
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
    )


def compile_addon(cc, source, headers, output, abi='arm64'):
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        cc, '-shared', '-fPIC', '-O2', '-Wall', '-Wextra',
        '-I', str(headers),
        str(source), '-o', str(output),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        raise ValueError(f'addon compilation failed: {result.stderr.strip()[:800]}')
    return command


def build(harness, headers, cc, out, abi='arm64'):
    harness = Path(harness).resolve()
    source = harness / ADDON_SOURCE
    if not source.is_file():
        raise ValueError(f'pinned harness source is missing {ADDON_SOURCE}')
    identity = compiler_identity(cc)
    header_ids = read_headers(headers)
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    target = out / 'bin/glibc/system.node'
    target.parent.mkdir(parents=True, exist_ok=True)
    command = compile_addon(identity['path'], source, headers, target, abi)
    facts = verify_addon(target, abi)
    # The Android engine tree is pruned of the whole linux-arm64 package, and flock.ts
    # resolves it via package.json; emit a bindable package, not a loose .node file.
    package_json = harness / 'native/system/packages/linux-arm64/package.json'
    if not package_json.is_file():
        raise ValueError('pinned harness is missing the linux-arm64 package.json')
    shutil.copyfile(package_json, out / 'package.json')
    receipt = dict(
        schemaVersion=1,
        abi=abi,
        target='glibc',
        addon='@deepseek-ai/node-addon-system/flock',
        nodeApi=8,
        source=dict(path=str(ADDON_SOURCE), sha256=sha256_file(source)),
        package=dict(name='@deepseek-ai/node-addon-system-linux-arm64',
                     packageJsonSha256=sha256_file(package_json)),
        headers=header_ids,
        compiler=identity,
        command=command,
        output=dict(path='bin/glibc/system.node', **facts),
        # Recorded, not silently omitted: the static-musl launcher needs a musl cross toolchain.
        deferred=[dict(addon='@deepseek-ai/node-addon-system/landlock-run',
                       reason='static musl aarch64 launcher requires a musl cross toolchain')],
    )
    (out / 'guest-addons.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


# ── self-test ────────────────────────────────────────────────────────────────────


def synthetic_elf(machine, etype=3, bits=64):
    """Minimal ELF with one PT_LOAD header; enough for the bounded parser to accept it."""
    ident = bytearray(16)
    ident[:4] = b'\x7fELF'
    ident[4] = 2 if bits == 64 else 1
    ident[5] = 1
    ident[6] = 1
    if bits == 64:
        header = struct.pack('<HHIQQQIHHHHHH', etype, machine, 1, 0, 64, 0, 0, 64, 56, 1, 0, 0, 0)
        total = 64 + 56
        phdr = struct.pack('<IIQQQQQQ', 1, 5, 0, 0, 0, total, total, 0x1000)
    else:
        header = struct.pack('<HHIIIIIHHHHHH', etype, machine, 1, 0, 52, 0, 0, 52, 32, 1, 0, 0, 0)
        total = 52 + 32
        phdr = struct.pack('<IIIIIIII', 1, 0, 0, 0, total, total, 5, 0x1000)
    return bytes(ident) + header + phdr


def self_test():
    checks = []

    def expect_ok(name, fn):
        fn()
        checks.append((name, True))

    def expect_reject(name, fn, needle):
        try:
            fn()
        except ValueError as error:
            if needle not in str(error):
                raise AssertionError(f'{name}: unexpected message {error}')
        else:
            raise AssertionError(f'{name}: expected rejection')
        checks.append((name, True))

    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        good = root / 'system.node'
        good.write_bytes(synthetic_elf(183))
        expect_ok('arm64 shared object accepted', lambda: verify_addon(good))

        bad_machine = root / 'x64.node'
        bad_machine.write_bytes(synthetic_elf(62))
        expect_reject('x86_64 fixture rejected', lambda: verify_addon(bad_machine), 'does not match arm64')

        executable = root / 'exec.node'
        executable.write_bytes(synthetic_elf(183, etype=2))
        expect_reject('executable rejected', lambda: verify_addon(executable), 'not a shared object')

        truncated = root / 'truncated.node'
        truncated.write_bytes(b'\x7fELF\x02\x01\x01')
        expect_reject('truncated fixture rejected', lambda: verify_addon(truncated), 'not a supported little-endian ELF')

        expect_reject('missing compiler rejected', lambda: compiler_identity('definitely-not-a-compiler'),
                      'cross compiler not found')
        expect_reject('missing headers rejected', lambda: read_headers(root / 'no-headers'),
                      'Node-API headers missing')
        expect_reject('missing pinned source rejected', lambda: build(root, root, 'cc', root / 'out'),
                      'pinned harness source is missing')

    for name, ok in checks:
        print(('PASS ' if ok else 'FAIL ') + name)
    print(f'{len(checks)} checks passed')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--harness')
    parser.add_argument('--headers')
    parser.add_argument('--cc', default='aarch64-linux-gnu-gcc')
    parser.add_argument('--out')
    parser.add_argument('--abi', default='arm64', choices=sorted(EXPECTED_MACHINE))
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    missing = [name for name in ('harness', 'headers', 'out') if not getattr(args, name)]
    if missing:
        parser.error('missing required arguments: ' + ', '.join('--' + name for name in missing))
    try:
        receipt = build(args.harness, args.headers, args.cc, args.out, args.abi)
    except ValueError as error:
        print(f'FAIL {error}', file=sys.stderr)
        return 1
    print(json.dumps(receipt['output'], ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
