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
PROFILE_DIR = 'home/.dsh/profiles'
PROFILE_PARENTS = {'home', 'home/.dsh', PROFILE_DIR}
APP_ID = re.compile(r'\bapplicationId\s*=\s*"([a-zA-Z0-9_.]+)"')
# Only shipped assembly profiles are required. headless-bad is a negative-control
# fixture used by tests; if an input snapshot happens to contain it, never overwrite it.
REQUIRED = {'web', 'headless'}
MAX_PATCH = 1024 * 1024


def verify(snapshot, authoritative, app_id):
    errors, found = [], {}
    try:
        text = authoritative.decode('utf-8')
    except UnicodeDecodeError:
        return ['authoritative patch is not UTF-8']
    for key in ('bashPath', 'prefix', 'home', 'cwd'):
        # The patch stores these under `config` for the shell-termux row, so real
        # authoritative keys are indented. Anchoring at column zero made the source
        # build reject every path despite the self-test's flat synthetic fixture.
        values = re.findall(r'^\s*' + key + r':\s*(\S+)\s*$', text, re.M)
        prefixes = (f'/data/data/{app_id}/files/', f'/data/user/0/{app_id}/files/')
        if len(values) != 1 or not values[0].startswith(prefixes) or posixpath.normpath(values[0]) != values[0]:
            errors.append(f'{key} must have one application-owned files path')
    with tarfile.open(snapshot, 'r|xz') as archive:
        for entry in archive:
            components = entry.name.split('/')
            if entry.name.startswith('/') or any(part in {'.', '..'} for part in components):
                errors.append(f'archive member path is not canonical: {entry.name}')
                continue
            normalized_name = posixpath.normpath(entry.name)
            under_profiles = normalized_name == PROFILE_DIR or normalized_name.startswith(PROFILE_DIR + '/')
            if (entry.issym() or entry.islnk()) and (
                normalized_name in PROFILE_PARENTS or under_profiles
            ):
                errors.append(f'profile archive path contains a link: {entry.name}')
            if normalized_name in PROFILE_PARENTS and not entry.isdir():
                errors.append(f'profile archive parent is not a directory: {entry.name}')
            match = PROFILE.fullmatch(normalized_name)
            if not match:
                continue
            if entry.name != normalized_name:
                errors.append(f'profile patch path is not canonical: {entry.name}')
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
    patch = (b'- insert:\n'
             b'    - id: shell-termux\n'
             b'      config:\n'
             b'        bashPath: /data/data/test.app/files/usr/bin/bash\n'
             b'        prefix: /data/data/test.app/files/usr\n'
             b'        home: /data/data/test.app/files/home\n'
             b'        cwd: /data/data/test.app/files/home\n')
    def archive(path, entries):
        with tarfile.open(path, 'w:xz') as tar:
            for name, data in entries:
                archive_name = name if name.startswith(('./', '/')) else 'home/.dsh/profiles/' + name + '/cordis.patch.yml'
                info = tarfile.TarInfo(archive_name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
    def archive_raw(path, entries):
        with tarfile.open(path, 'w:xz') as tar:
            for name, data in entries:
                info = tarfile.TarInfo(name)
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
            ([('web/../web', patch), ('headless', patch), ('headless-bad', b'negative')], patch, 'test.app', True),
            ([('./home/.dsh/profiles/web/cordis.patch.yml', patch), ('home/.dsh/profiles/headless/cordis.patch.yml', patch), ('home/.dsh/profiles/headless-bad/cordis.patch.yml', b'negative')], patch, 'test.app', True),
            ([('web', patch), ('headless', patch)], patch, 'test.app', False),
            ([('web', patch + b'        prefix: /data/data/test.app/files/usr\n'),
              ('headless', patch), ('headless-bad', b'negative')], patch, 'test.app', True),
            (good, patch, 'wrong.app', True),
            (good, patch.replace(b'/files/usr/bin/bash', b'/files/../../outside'), 'test.app', True),
            ([('web', patch), ('headless', patch), ('headless-bad', patch)], patch, 'test.app', True),
            ([('web', b'x' * (MAX_PATCH + 1)), ('headless', patch), ('headless-bad', b'negative')], patch, 'test.app', True),
        ]
        for entries, authority, app_id, expect_failure in cases:
            archive(path, entries)
            assert bool(verify(path, authority, app_id)) == expect_failure
        real_patch = (ROOT / 'scripts' / 'profile-web.cordis.patch.yml').read_bytes()
        gradle = (ROOT / 'app' / 'build.gradle.kts').read_text(encoding='utf-8')
        real_ids = APP_ID.findall(gradle)
        assert len(real_ids) == 1, 'real project applicationId must be unique'
        archive(path, [('web', real_patch), ('headless', real_patch)])
        assert verify(path, real_patch, real_ids[0]) == [], 'real nested shell-termux config must pass'
        with tarfile.open(path, 'w:xz') as tar:
            web = tarfile.TarInfo('home/.dsh/profiles/web/cordis.patch.yml')
            web.type = tarfile.SYMTYPE
            web.linkname = 'outside'
            tar.addfile(web)
            for name, data in [('headless', patch), ('headless-bad', b'negative')]:
                info = tarfile.TarInfo('home/.dsh/profiles/' + name + '/cordis.patch.yml')
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        assert verify(path, patch, 'test.app'), 'symlinked profile must fail'
        with tarfile.open(path, 'w:xz') as tar:
            parent = tarfile.TarInfo('home/.dsh/profiles/web')
            parent.type = tarfile.SYMTYPE
            parent.linkname = '/tmp/outside'
            tar.addfile(parent)
            for name, data in [('web', patch), ('headless', patch), ('headless-bad', b'negative')]:
                info = tarfile.TarInfo('home/.dsh/profiles/' + name + '/cordis.patch.yml')
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        assert verify(path, patch, 'test.app'), 'symlinked profile directory must fail'
        archive_raw(path, [('home/.dsh/profiles/web/cordis.patch.yml', patch),
                           ('/home/.dsh/profiles/web/cordis.patch.yml', b'alias'),
                           ('home/.dsh/profiles/headless/cordis.patch.yml', patch),
                           ('home/.dsh/profiles/headless-bad/cordis.patch.yml', b'negative')])
        assert verify(path, patch, 'test.app'), 'absolute duplicate profile path must fail'
    print('snapshot profile identity self-test passed: 3 positive, 13 controlled negatives')


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
