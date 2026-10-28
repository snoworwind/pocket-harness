#!/usr/bin/env python3
"""Fail closed if final snapshot profile patches or application paths drift."""
import io
import posixpath
import re
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROFILE = re.compile(r'^home/\.dsh/profiles/([^/]+)/cordis\.patch\.yml$')
APP_ID = re.compile(r'\bapplicationId\s*=\s*"([a-zA-Z0-9_.]+)"')
REQUIRED = {'web', 'headless'}
MAX_PATCH = 1024 * 1024


def verify(snapshot, authoritative, app_id):
    errors, found = [], {}
    try:
        text = authoritative.decode('utf-8')
    except UnicodeDecodeError:
        return ['authoritative patch is not UTF-8']
    for key in ('bashPath', 'prefix', 'home', 'cwd'):
        values = re.findall(r'^\s*' + key + r':\s*(\S+)\s*$', text, re.M)
        prefixes = (f'/data/data/{app_id}/files/', f'/data/user/0/{app_id}/files/')
        if len(values) != 1 or not values[0].startswith(prefixes) or posixpath.normpath(values[0]) != values[0]:
            errors.append(f'{key} must have one application-owned files path')
    with tarfile.open(snapshot, 'r|xz') as archive:
        for entry in archive:
            match = PROFILE.fullmatch(posixpath.normpath(entry.name))
            if not match:
                continue
            profile = match.group(1)
            if profile in found:
                errors.append(f'duplicate profile patch: {profile}')
                continue
            if not entry.isfile() or entry.size > MAX_PATCH:
                errors.append(f'profile patch is not a bounded regular file: {profile}')
                found[profile] = None
                continue
            member = archive.extractfile(entry)
            found[profile] = member.read() if member else None
    for profile in REQUIRED - found.keys():
        errors.append(f'missing profile patch: {profile}')
    for profile, content in found.items():
        if profile == 'headless-bad':
            if content == authoritative:
                errors.append('negative control profile was overwritten')
        elif content != authoritative:
            errors.append(f'profile patch differs from authoritative bytes: {profile}')
    return errors


def self_test():
    patch = b'bashPath: /data/data/test.app/files/usr/bin/bash\nprefix: /data/data/test.app/files/usr\nhome: /data/data/test.app/files/home\ncwd: /data/data/test.app/files/home\n'
    def archive(path, entries):
        with tarfile.open(path, 'w:xz') as tar:
            for name, data in entries:
                info = tarfile.TarInfo('home/.dsh/profiles/' + name + '/cordis.patch.yml')
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
    with tempfile.TemporaryDirectory(prefix='profile-gate-') as tmp:
        path = Path(tmp) / 'snapshot.tar.xz'
        good = [('web', patch), ('headless', patch), ('headless-bad', b'negative')]
        cases = [
            (good, patch, 'test.app', False),
            ([('web', patch)], patch, 'test.app', True),
            ([('web', patch), ('headless', b'changed')], patch, 'test.app', True),
            (good + [('web', patch)], patch, 'test.app', True),
            (good, patch, 'wrong.app', True),
            (good, patch.replace(b'/files/usr/bin/bash', b'/files/../../outside'), 'test.app', True),
            ([('web', patch), ('headless', patch), ('headless-bad', patch)], patch, 'test.app', True),
        ]
        for entries, authority, app_id, expect_failure in cases:
            archive(path, entries)
            assert bool(verify(path, authority, app_id)) == expect_failure
        with tarfile.open(path, 'w:xz') as tar:
            for name in ('web', 'headless'):
                info = tarfile.TarInfo('home/.dsh/profiles/' + name + '/cordis.patch.yml')
                if name == 'web':
                    info.type = tarfile.SYMTYPE
                    info.linkname = 'outside'
                    tar.addfile(info)
                else:
                    info.size = len(patch)
                    tar.addfile(info, io.BytesIO(patch))
        assert verify(path, patch, 'test.app'), 'symlinked profile must fail'
    print('snapshot profile identity self-test passed: 1 positive, 7 controlled negatives')


def main():
    if sys.argv[1:] == ['--self-test']:
        self_test()
        return
    if len(sys.argv) != 2:
        raise ValueError('usage: check-snapshot-profile-identity.py <snapshot.tar.xz> | --self-test')
    ids = APP_ID.findall((ROOT / 'app/build.gradle.kts').read_text(encoding='utf-8'))
    if len(ids) != 1:
        raise ValueError('expected exactly one applicationId')
    errors = verify(sys.argv[1], (ROOT / 'scripts/profile-web.cordis.patch.yml').read_bytes(), ids[0])
    if errors:
        raise ValueError('; '.join(errors))
    print('snapshot profile identity passed: authoritative bytes and application paths')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, tarfile.TarError) as exc:
        print('snapshot profile identity failed: ' + str(exc), file=sys.stderr)
        sys.exit(1)
