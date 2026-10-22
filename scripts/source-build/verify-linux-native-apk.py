#!/usr/bin/env python3
"""Verify the exact PRoot runtime, loader, and dependency bytes present in an APK."""
import argparse
import hashlib
import json
import os
import stat
import tempfile
import zipfile


EXPECTED = (
    'lib/arm64-v8a/libpocketharness_proot.so',
    'lib/arm64-v8a/libpocketharness_proot_loader.so',
    'lib/arm64-v8a/libtalloc.so',
    'lib/arm64-v8a/libandroid-shmem.so',
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


def verify(apk, native_library_root, license_root, provenance_path):
    if os.path.islink(provenance_path) or not os.path.isfile(provenance_path):
        fail('Linux backend provenance must be a regular file')
    with open(provenance_path, 'r', encoding='utf-8') as stream:
        provenance = json.load(stream)
    if provenance.get('schemaVersion') != 1 or provenance.get('target') != 'proot':
        fail('Linux backend provenance has an unsupported schema or target')
    library_records = provenance.get('nativeLibraries')
    if not isinstance(library_records, list):
        fail('Linux backend provenance has no native library records')
    recorded_libraries = {item.get('name'): item for item in library_records if isinstance(item, dict)}
    expected_names = {member.rsplit('/', 1)[1] for member in EXPECTED}
    if len(recorded_libraries) != len(library_records) or set(recorded_libraries) != expected_names:
        fail('Linux backend provenance native library set is not exact')

    native_library_root = os.path.abspath(native_library_root)
    if os.path.islink(native_library_root) or not os.path.isdir(native_library_root):
        fail('native library root must be a real directory')
    source_root = os.path.join(native_library_root, 'arm64-v8a')
    if os.path.islink(source_root) or not os.path.isdir(source_root):
        fail('ARM64 native library directory must be a real directory')
    expected = {}
    for member in EXPECTED:
        name = member.rsplit('/', 1)[1]
        source = os.path.join(source_root, name)
        if not os.path.isfile(source) or os.path.islink(source) or not os.access(source, os.X_OK):
            fail(f'source library is missing, linked, or not executable: {source}')
        source_hash = digest(source)
        recorded = recorded_libraries[name]
        if (recorded.get('size'), recorded.get('sha256')) != source_hash:
            fail(f'source library differs from Termux provenance: {name}')
        expected[member] = source_hash

    if os.path.islink(license_root) or not os.path.isdir(license_root):
        fail('Linux native license directory is missing or unsafe')
    license_root = os.path.realpath(license_root)
    expected_licenses = {}
    for current, directories, files in os.walk(license_root, followlinks=False):
        if any(os.path.islink(os.path.join(current, name)) for name in directories):
            fail('Linux native license directory contains a symlink')
        for name in files:
            source = os.path.join(current, name)
            if not os.path.isfile(source) or os.path.islink(source):
                fail(f'Linux native license is not a regular file: {source}')
            relative = os.path.relpath(source, license_root).replace(os.sep, '/')
            expected_licenses[f'assets/licenses/linux-native/{relative}'] = digest(source)
    if not expected_licenses:
        fail('Linux native license directory is empty')
    license_records = provenance.get('licenseFiles')
    if not isinstance(license_records, list):
        fail('Linux backend provenance has no license records')
    recorded_licenses = {}
    for item in license_records:
        if not isinstance(item, dict) or not isinstance(item.get('path'), str):
            fail('Linux backend provenance contains an invalid license record')
        relative = item['path']
        if relative.startswith('/') or '\\' in relative or any(part in ('', '.', '..') for part in relative.split('/')):
            fail(f'Linux backend provenance contains an unsafe license path: {relative}')
        if relative in recorded_licenses:
            fail(f'Linux backend provenance contains a duplicate license path: {relative}')
        recorded_licenses[relative] = (item.get('size'), item.get('sha256'))
    source_licenses = {
        member.removeprefix('assets/licenses/linux-native/'): value
        for member, value in expected_licenses.items()
    }
    if recorded_licenses != source_licenses:
        fail('Linux native license files differ from Termux provenance')

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
            for member, source_hash in expected_licenses.items():
                matches = [entry for entry in members if entry.filename == member]
                if len(matches) != 1:
                    fail(f'APK must contain exactly one {member} license entry')
                entry = matches[0]
                if entry.is_dir() or ((entry.external_attr >> 16) & 0xFFFF and stat.S_IFMT((entry.external_attr >> 16) & 0xFFFF) not in (0, stat.S_IFREG)):
                    fail(f'APK native license is not a regular file: {member}')
                value = hashlib.sha256()
                size = 0
                with archive.open(entry, 'r') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        size += len(chunk)
                        value.update(chunk)
                if (size, value.hexdigest()) != source_hash:
                    fail(f'APK license bytes differ from the verified license source: {member}')
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
        licenses = os.path.join(temporary, 'licenses')
        os.makedirs(os.path.join(licenses, 'proot'), exist_ok=True)
        with open(os.path.join(licenses, 'proot', 'copyright'), 'wb') as stream:
            stream.write(b'GPL notice fixture')
        provenance = {
            'schemaVersion': 1,
            'target': 'proot',
            'nativeLibraries': [
                {'name': os.path.basename(source), 'size': digest(source)[0], 'sha256': digest(source)[1]}
                for source in source_files
            ],
            'licenseFiles': [
                {'path': 'proot/copyright', 'size': digest(os.path.join(licenses, 'proot', 'copyright'))[0],
                 'sha256': digest(os.path.join(licenses, 'proot', 'copyright'))[1]},
            ],
        }
        provenance_path = os.path.join(temporary, 'provenance.json')
        with open(provenance_path, 'w', encoding='utf-8') as stream:
            json.dump(provenance, stream)
        apk = os.path.join(temporary, 'fixture.apk')
        with zipfile.ZipFile(apk, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for member, source in zip(EXPECTED, source_files):
                archive.write(source, member)
            archive.write(os.path.join(licenses, 'proot', 'copyright'), 'assets/licenses/linux-native/proot/copyright')
        verify(apk, os.path.join(temporary, 'native-libs'), licenses, provenance_path)

        linked_native_root = os.path.join(temporary, 'native-libs-link')
        os.symlink(os.path.join(temporary, 'native-libs'), linked_native_root)
        try:
            verify(apk, linked_native_root, licenses, provenance_path)
        except ValueError as error:
            if 'native library root must be a real directory' not in str(error):
                raise
        else:
            raise AssertionError('symlinked native library root was accepted')

        saved_abi = os.path.join(temporary, 'native-libs', 'arm64-v8a-real')
        os.rename(source_root, saved_abi)
        os.symlink(saved_abi, source_root)
        try:
            verify(apk, os.path.join(temporary, 'native-libs'), licenses, provenance_path)
        except ValueError as error:
            if 'ARM64 native library directory must be a real directory' not in str(error):
                raise
        else:
            raise AssertionError('symlinked ARM64 native library directory was accepted')
        os.unlink(source_root)
        os.rename(saved_abi, source_root)

        linked_licenses = os.path.join(temporary, 'licenses-link')
        os.symlink(licenses, linked_licenses)
        try:
            verify(apk, os.path.join(temporary, 'native-libs'), linked_licenses, provenance_path)
        except ValueError as error:
            if 'license directory is missing or unsafe' not in str(error):
                raise
        else:
            raise AssertionError('symlinked native license root was accepted')

        with zipfile.ZipFile(apk, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for member, source in zip(EXPECTED, source_files):
                with open(source, 'rb') as stream:
                    payload = stream.read()
                archive.writestr(member, payload + (b'-tampered' if member == EXPECTED[0] else b''))
            archive.write(os.path.join(licenses, 'proot', 'copyright'), 'assets/licenses/linux-native/proot/copyright')
        try:
            verify(apk, os.path.join(temporary, 'native-libs'), licenses, provenance_path)
        except ValueError as error:
            if 'bytes differ' not in str(error):
                raise
        else:
            fail('self-test accepted a modified native library')

        with zipfile.ZipFile(apk, 'w', compression=zipfile.ZIP_STORED) as archive:
            for member, source in zip(EXPECTED, source_files):
                archive.write(source, member)
            archive.write(os.path.join(licenses, 'proot', 'copyright'), 'assets/licenses/linux-native/proot/copyright')
        try:
            verify(apk, os.path.join(temporary, 'native-libs'), licenses, provenance_path)
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
            archive.write(os.path.join(licenses, 'proot', 'copyright'), 'assets/licenses/linux-native/proot/copyright')
        try:
            verify(apk, os.path.join(temporary, 'native-libs'), licenses, provenance_path)
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
    parser.add_argument('license_root', nargs='?')
    parser.add_argument('provenance', nargs='?')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.apk or not args.native_library_root or not args.license_root or not args.provenance:
        parser.error('apk, native_library_root, license_root and provenance are required')
    verified = verify(args.apk, args.native_library_root, args.license_root, args.provenance)
    for name in EXPECTED:
        size, sha = verified[name]
        print(f'{sha} {size} {name}')
    print('PASS Linux native APK: exact ARM64 PRoot, loader, and dependency payloads')


if __name__ == '__main__':
    main()
