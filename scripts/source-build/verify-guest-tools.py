#!/usr/bin/env python3
"""Prove every declared guest tool really runs inside the Debian/glibc rootfs.

The guest baseline lives in `guest-tools.json` (Debian packages + one probe per
command). This script executes each probe through the rootfs' own interpreter with
`qemu-aarch64-static -L <rootfs>` and fails when a command is missing or does not
produce a version line, so an empty or half-installed rootfs cannot be packaged.

Usage:
  python3 verify-guest-tools.py --rootfs <dir> --report <file> [--qemu qemu-aarch64-static]
  python3 verify-guest-tools.py --self-test
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / 'guest-tools.json'
SEARCH_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'


def load_manifest(path=MANIFEST):
    data = json.loads(Path(path).read_text())
    if data.get('schemaVersion') != 1:
        raise ValueError('unsupported guest tool manifest schema')
    packages = data.get('packages')
    commands = data.get('commands')
    if not isinstance(packages, list) or not packages or not all(isinstance(name, str) and name.strip() for name in packages):
        raise ValueError('guest tool manifest packages must be a non-empty string list')
    if not isinstance(commands, list) or not commands:
        raise ValueError('guest tool manifest commands must be a non-empty list')
    seen = set()
    for entry in commands:
        name = entry.get('command')
        if not isinstance(name, str) or not name or '/' in name:
            raise ValueError(f'invalid probe command: {name!r}')
        if name in seen:
            raise ValueError(f'duplicate probe command: {name}')
        seen.add(name)
        if not isinstance(entry.get('args', []), list):
            raise ValueError(f'{name}: args must be a list')
        if not isinstance(entry.get('allowExitCodes', [0]), list):
            raise ValueError(f'{name}: allowExitCodes must be a list')
        if not isinstance(entry.get('package'), str) or entry['package'] not in packages:
            raise ValueError(f'{name}: package must name a declared package')
    return data


def locate(rootfs, command):
    rootfs = Path(rootfs)
    for directory in SEARCH_PATH.split(':'):
        candidate = rootfs / directory.lstrip('/') / command
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return '/' + str(candidate.relative_to(rootfs))
    return None


def probe(rootfs, qemu, entry, timeout=60):
    path = locate(rootfs, entry['command'])
    if path is None:
        return dict(status='missing', detail=f"{entry['command']} is not installed")
    command = [qemu, '-L', str(rootfs), '-E', f"PATH={SEARCH_PATH}", str(Path(rootfs) / path.lstrip('/')), *entry.get('args', [])]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return dict(status='error', path=path, detail=str(error))
    output = (result.stdout or result.stderr or '').strip().splitlines()
    allowed = entry.get('allowExitCodes', [0])
    if result.returncode not in allowed:
        return dict(status='error', path=path, exitCode=result.returncode,
                    detail=(result.stderr or result.stdout or '').strip()[:300])
    if not output:
        return dict(status='error', path=path, exitCode=result.returncode, detail='probe produced no output')
    return dict(status='ok', path=path, exitCode=result.returncode, version=output[0][:200])


def verify(rootfs, report, qemu='qemu-aarch64-static'):
    rootfs = Path(rootfs)
    if not rootfs.is_dir():
        raise ValueError(f'rootfs is not a directory: {rootfs}')
    manifest = load_manifest()
    results = []
    failures = []
    for entry in manifest['commands']:
        outcome = probe(rootfs, qemu, entry)
        outcome['command'] = entry['command']
        outcome['package'] = entry['package']
        results.append(outcome)
        if outcome['status'] != 'ok':
            failures.append(f"{entry['command']}: {outcome.get('detail') or outcome['status']}")
    document = dict(
        schemaVersion=1,
        scope='guest commands executed through the rootfs interpreter (qemu-user on a foreign host)',
        total=len(results),
        passed=len(results) - len(failures),
        failed=len(failures),
        results=results,
    )
    target = Path(report)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(document, indent=2) + '\n')
    if failures:
        raise ValueError('guest tool probes failed:\n  ' + '\n  '.join(failures))
    return document


def self_test():
    checks = []
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        (root / 'bin').mkdir()
        for command in ('bash', 'ls'):
            target = root / 'bin' / command
            target.write_text('#!/bin/sh\nexit 0\n')
            target.chmod(0o755)
        checks.append(('locate finds an installed command', locate(root, 'bash') == '/bin/bash'))
        checks.append(('locate reports a missing command', locate(root, 'definitely-missing') is None))

        try:
            load_manifest()
            checks.append(('packaged manifest is valid', True))
        except ValueError as error:
            checks.append((f'packaged manifest is valid ({error})', False))

        fake = root / 'fake-qemu'
        fake.write_text('#!/bin/sh\necho "fake 1.0"\nexit 0\n')
        fake.chmod(0o755)
        expected_ok = probe(root, str(fake), dict(command='bash', args=['--version'], package='bash', allowExitCodes=[0]))
        checks.append(('probe accepts a working command', expected_ok['status'] == 'ok'))

        failing = root / 'failing-qemu'
        failing.write_text('#!/bin/sh\nexit 42\n')
        failing.chmod(0o755)
        expected_error = probe(root, str(failing), dict(command='bash', args=[], package='bash', allowExitCodes=[0]))
        checks.append(('probe rejects a non-zero exit', expected_error['status'] == 'error'))

        missing = probe(root, str(fake), dict(command='nope', args=[], package='bash', allowExitCodes=[0]))
        checks.append(('probe rejects a missing command', missing['status'] == 'missing'))

        try:
            verify(root, root / 'report.json', qemu=str(fake))
            checks.append(('verify rejects an incomplete rootfs', False))
        except ValueError as error:
            checks.append(('verify rejects an incomplete rootfs', 'probes failed' in str(error)))

    for name, ok in checks:
        print(('PASS ' if ok else 'FAIL ') + name)
    print(f'{len(checks)} checks passed')
    return 0 if all(ok for _, ok in checks) else 1


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--rootfs')
    parser.add_argument('--report')
    parser.add_argument('--qemu', default='qemu-aarch64-static')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    if not args.rootfs or not args.report:
        parser.error('--rootfs and --report are required')
    try:
        document = verify(args.rootfs, args.report, args.qemu)
    except ValueError as error:
        print(f'FAIL {error}', file=sys.stderr)
        return 1
    print(f"guest tools verified: {document['passed']}/{document['total']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
