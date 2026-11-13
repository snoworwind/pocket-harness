#!/usr/bin/env python3
"""Run foreign stage two with native host metadata parsing and bounded diagnostics."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def run(rootfs, executable='debootstrap', timeout_seconds=900, heartbeat_seconds=30):
    rootfs = Path(rootfs).resolve(strict=True)
    metadata = rootfs / 'debootstrap'
    if rootfs == Path('/') or not rootfs.is_dir() or metadata.is_symlink() or not metadata.is_dir():
        raise ValueError('second-stage target must be a dedicated rootfs with real debootstrap metadata')
    if timeout_seconds <= 0 or heartbeat_seconds <= 0:
        raise ValueError('bootstrap time limits must be positive')
    # Supported debootstrap interface: host shell/Perl resolve metadata, while its
    # in_target() still chroots target dpkg and maintainer scripts through binfmt.
    command = [executable, '--second-stage', f'--second-stage-target={rootfs}']
    env = {**os.environ, 'DEBOOTSTRAP_DIR': str(metadata)}
    started = time.monotonic()
    log = metadata / 'debootstrap.log'
    offset = log.stat().st_size if log.is_file() and not log.is_symlink() else 0

    def report():
        nonlocal offset
        print(f'Linux bootstrap stage two: {time.monotonic() - started:.1f}s elapsed', flush=True)
        if log.is_file() and not log.is_symlink():
            size = log.stat().st_size
            with log.open('rb') as stream:
                # Never load an unbounded maintainer-script log into memory.
                stream.seek(max(0, size - 16384, offset if size >= offset else 0))
                data = stream.read(16384)
            offset = size
            if data:
                print(data.decode('utf-8', errors='replace'), end='', flush=True)

    print('Running debootstrap stage two on the host for target ' + str(rootfs), flush=True)
    process = subprocess.Popen(command, env=env, start_new_session=True)
    def interrupted(signum, frame):
        raise InterruptedError('Linux bootstrap interrupted')
    previous_term = signal.signal(signal.SIGTERM, interrupted)
    try:
        while True:
            remaining = timeout_seconds - (time.monotonic() - started)
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout_seconds)
            try:
                status = process.wait(timeout=min(heartbeat_seconds, remaining))
                report()
                return status
            except subprocess.TimeoutExpired:
                report()
    except BaseException:
        # Kill the whole private process group, including target dpkg/QEMU children.
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        # A terminated parent can leave a child that ignores TERM in its group.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        raise
    finally:
        signal.signal(signal.SIGTERM, previous_term)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('rootfs', nargs='?')
    parser.add_argument('--timeout-seconds', type=int, default=900)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        return subprocess.call([sys.executable, '-m', 'unittest', 'discover', '-s', str(Path(__file__).parent), '-p', 'test_run_linux_bootstrap.py'])
    if not args.rootfs:
        parser.error('rootfs is required')
    try:
        return run(args.rootfs, timeout_seconds=args.timeout_seconds)
    except subprocess.TimeoutExpired:
        print('Linux bootstrap stage two exceeded its bounded time limit; target was not packaged', file=sys.stderr)
        return 124


if __name__ == '__main__':
    sys.exit(main())
