#!/usr/bin/env python3
"""Verify the exact Linux launcher and glibc loader bytes are present in an APK."""
import argparse
import hashlib
import os
import stat
import tempfile
import zipfile


EXPECTED = (
    'lib/arm64-v8a/libpocketharness_bionilux.so',
    'lib/arm64-v8a/libpocketharness_glibc_loader.so',
)
MAX_LIBRARY_BYTES = 64 * 1024 * 1024


def fail(message):
    raise ValueError(f'Linux native APK check: {message}')


def digest(path):
    value = hashlib.sha256()
    size = 0
    with open(path, 'rb') as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_LIBRARY_BYTES:
                fail(f'{path} exceeds the library size limit')
            value.update(chunk)
    return size, value.hexdigest()


def verify(apk, native_library_root):
    source_root = os.path.join(os.path.realpath(native_library_root), 'arm64-v8a')
    expected = {}
    for member in EXPECTED:
        name = member.rsplit('/', 1)[1]
        source = os.path.join(source_root, name)
        if not os.path.isfile(source) or os.path.islink(source) or not os.access(source, os.X_OK):
            fail(f'source library is missing, linked, or not executable: {source}')
        expected[member] = digest(source)

    try:
        with zipfile.ZipFile(apk, 'r') as archive:
            members = archive.infolist()
            for member, source_hash in expected.items():
                matches = [entry for entry in members if entry.filename == member]
                if len(matches) != 1:
                    fail(f'APK must contain exactly one {member} entry')
                entry = matches[0]
                mode = (entry.external_attr >> 16) & 0xFFFF
                file_type = stat.S_IFMT(mode)
                if entry.is_dir() or file_type not in (0, stat.S_IFREG):
                    fail(f'APK native library is not a regular file: {member}')
                if entry.compress_type == zipfile.ZIP_STORED:
                    fail(f'APK native library must be compressed so PackageManager extracts it: {member}')
                value = hashlib.sha256()
                size = 0
                with archive.open(entry, 'r') as stream:
                    while True:
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > MAX_LIBRARY_BYTES:
                            fail(f'APK library exceeds the size limit: {member}')
                        value.update(chunk)
                if (size, value.hexdigest()) != source_hash:
                    fail(f'APK bytes differ from the source-built library: {member}')
    except (OSError, zipfile.BadZipFile) as error:
        fail(f'cannot inspect APK: {error}')
    return expected


def self_test():
    with tempfile.TemporaryDirectory(prefix='linux-native-apk-') as temporary:
        source_root = os.path.join(temporary, 'native-libs', 'arm64-v8a')
        os.makedirs(source_root)
        source_files = [
            os.path.join(source_root, member.rsplit('/', 1)[1])
            for member in EXPECTED
        ]
        for index, source in enumerate(source_files):
            with open(source, 'wb') as stream:
                stream.write((f'fixture-{index}').encode())
            os.chmod(source, 0o755)
        apk = os.path.join(temporary, 'fixture.apk')
        with zipfile.ZipFile(apk, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for member, source in zip(EXPECTED, source_files):
                archive.write(source, member)
        verify(apk, os.path.join(temporary, 'native-libs'))

        with zipfile.ZipFile(apk, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for member, source in zip(EXPECTED, source_files):
                with open(source, 'rb') as stream:
                    payload = stream.read()
                archive.writestr(member, payload + (b'-tampered' if member == EXPECTED[0] else b''))
        try:
            verify(apk, os.path.join(temporary, 'native-libs'))
        except ValueError as error:
            if 'bytes differ' not in str(error):
                raise
        else:
            fail('self-test accepted a modified native library')

        with zipfile.ZipFile(apk, 'w', compression=zipfile.ZIP_STORED) as archive:
            for member, source in zip(EXPECTED, source_files):
                archive.write(source, member)
        try:
            verify(apk, os.path.join(temporary, 'native-libs'))
        except ValueError as error:
            if 'must be compressed' not in str(error):
                raise
        else:
            fail('self-test accepted an unextracted native library')

        with zipfile.ZipFile(apk, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for member, source in zip(EXPECTED, source_files):
                info = zipfile.ZipInfo(member)
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                with open(source, 'rb') as stream:
                    archive.writestr(info, stream.read())
        try:
            verify(apk, os.path.join(temporary, 'native-libs'))
        except ValueError as error:
            if 'not a regular file' not in str(error):
                raise
        else:
            fail('self-test accepted a symlink native library')
    print('PASS Linux native APK: payload match, extraction packaging, and regular-file checks')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('apk', nargs='?')
    parser.add_argument('native_library_root', nargs='?')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.apk or not args.native_library_root:
        parser.error('apk and native_library_root are required')
    verified = verify(args.apk, args.native_library_root)
    for name in EXPECTED:
        size, sha = verified[name]
        print(f'{sha} {size} {name}')
    print('PASS Linux native APK: exact ARM64 launcher and glibc loader payloads')


if __name__ == '__main__':
    main()
