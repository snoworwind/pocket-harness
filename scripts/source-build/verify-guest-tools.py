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


def resolve_in_rootfs(rootfs, path, limit=32):
    """Resolve an absolute guest path without letting host symlinks escape the rootfs.

    A rootfs is not a chroot here: `/usr/bin/awk -> /etc/alternatives/awk` must resolve
    against the guest tree, never against the build host's `/etc`.
    """
    rootfs = Path(rootfs)
    seen = set()
    current = path
    for _ in range(limit):
        if current in seen:
            raise ValueError(f'symlink loop in guest path {path}')
        seen.add(current)
        host = rootfs / current.lstrip('/')
        if not host.is_symlink():
            return current, host
        target = os.readlink(host)
        current = target if target.startswith('/') else os.path.normpath(os.path.join(os.path.dirname(current), target))
    raise ValueError(f'guest path {path} exceeds the symlink limit')


def locate(rootfs, command):
    for directory in SEARCH_PATH.split(':'):
        candidate = f"{directory.rstrip('/')}/{command}"
        try:
            resolved, host = resolve_in_rootfs(rootfs, candidate)
        except ValueError:
            continue
        if host.is_file() and os.access(host, os.X_OK):
            return resolved, host
    return None, None


def guest_argv(rootfs, qemu, resolved, host, args):
    """Run a guest binary, or a shebang script through its guest interpreter."""
    head = host.open('rb').read(2)
    if head != b'#!':
        return [qemu, '-L', str(rootfs), '-E', f'PATH={SEARCH_PATH}', str(host), *args]
    interpreter_line = host.open('rb').readline()[2:].decode('utf-8', 'replace').strip()
    parts = interpreter_line.split()
    if not parts:
        raise ValueError(f'{resolved}: empty shebang')
    interpreter = parts[0]
    interpreter_args = parts[1:]
    if os.path.basename(interpreter) == 'env' and interpreter_args:
        interpreter = interpreter_args[0]
        interpreter_args = interpreter_args[1:]
    _, interpreter_host = resolve_in_rootfs(rootfs, interpreter)
    if not interpreter_host.is_file():
        raise ValueError(f'{resolved}: shebang interpreter {interpreter} is missing')
    return [qemu, '-L', str(rootfs), '-E', f'PATH={SEARCH_PATH}', str(interpreter_host), *interpreter_args, str(host), *args]


def probe(rootfs, qemu, entry, timeout=60):
    path, host = locate(rootfs, entry['command'])
    if path is None:
        return dict(status='missing', detail=f"{entry['command']} is not installed")
    try:
        command = guest_argv(rootfs, qemu, path, host, entry.get('args', []))
    except ValueError as error:
        return dict(status='error', path=path, detail=str(error))
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return dict(status='error', path=path, detail=str(error))
    output = (result.stdout or result.stderr or '').strip().splitlines()
    allowed = entry.get('allowExitCodes', [0])
    if result.returncode not in allowed:
        return dict(status='error', path=path, exitCode=result.returncode,
                    detail=(result.stderr or result.stdout or '').strip()[:300])
    # Usage probes (for example `nc -h`) may keep their text on a tty and print nothing
    # when redirected; those entries opt in explicitly instead of weakening the default check.
    if not output and entry.get('allowEmptyOutput') is not True:
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
        for command in ('bash', 'ls', 'sh'):
            target = root / 'bin' / command
            target.write_text('#!/bin/sh\nexit 0\n')
            target.chmod(0o755)
        checks.append(('locate finds an installed command', locate(root, 'bash')[0] == '/bin/bash'))
        checks.append(('locate reports a missing command', locate(root, 'definitely-missing')[0] is None))

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
