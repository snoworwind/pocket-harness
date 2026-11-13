#!/usr/bin/env python3
"""Inventory a source-built snapshot before migrating host code to APK native libs.

Read-only, no subprocess execution and no symlink traversal during the walk. This
is an inventory gate, NOT a claim that the payload has been migrated or can run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import struct
import sys
import zipfile

MACHINES = {40: 'arm', 62: 'x86_64', 183: 'arm64'}
ABI_MACHINE = {'arm64': 183, 'x86_64': 62}
DEFAULT_PREFIX = '/data/user/0/com.snoworwind.pocketharness/files/usr'


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def elf_metadata(data):
    """Parse bounded ELF metadata; never use readelf from the inspected payload."""
    if len(data) < 16 or data[:4] != b'\x7fELF' or data[5:7] != b'\x01\x01':
        raise ValueError('not a supported little-endian ELF')
    bits = {1: 32, 2: 64}.get(data[4])
    if bits is None:
        raise ValueError('invalid ELF class')
    header = '<HHIIIIIHHHHHH' if bits == 32 else '<HHIQQQIHHHHHH'
    if len(data) < 16 + struct.calcsize(header):
        raise ValueError('truncated ELF header')
    kind, machine, version, entry, phoff, _, _, ehsize, phsize, phnum, *_ = struct.unpack_from(header, data, 16)
    expected_phsize = 32 if bits == 32 else 56
    if version != 1 or kind not in (1, 2, 3) or ehsize != 16 + struct.calcsize(header):
        raise ValueError('unsupported ELF type or header')
    if kind == 1:
        # Compiler/sysroot .o files are code-generation inputs, not launchable
        # programs. Retain them in the inventory without proposing APK execution.
        if entry or phnum:
            raise ValueError('unexpected entry or program headers in relocatable ELF')
        return dict(bits=bits, machine=machine, architecture=MACHINES.get(machine, f'elf-machine-{machine}'),
                    type=kind, entry=0, interpreter=None, environment='relocatable-object', needed=[],
                    soname=[], rpath=[], runpath=[], loadSegments=[], elf16kAligned=None,
                    writableExecutableSegments=False)
    if phnum < 1 or phsize != expected_phsize or phoff < ehsize or phoff + phsize * phnum > len(data):
        raise ValueError('invalid ELF program header table')
    loads, interpreters, dynamic = [], [], []
    for index in range(phnum):
        values = struct.unpack_from('<IIIIIIII' if bits == 32 else '<IIQQQQQQ', data, phoff + index * phsize)
        if bits == 32:
            ptype, offset, address, _, filesz, memsz, flags, align = values
        else:
            ptype, flags, offset, address, _, filesz, memsz, align = values
        if offset + filesz > len(data):
            raise ValueError('ELF segment extends beyond file')
        if ptype == 1:
            if filesz > memsz or (align > 1 and (align & (align - 1) or (address - offset) % align)):
                raise ValueError('invalid ELF load segment')
            loads.append(dict(offset=offset, address=address, fileSize=filesz, memorySize=memsz, flags=flags, alignment=align))
        elif ptype == 3:
            raw = data[offset:offset + filesz]
            if not raw or raw[-1:] != b'\0' or b'\0' in raw[:-1]:
                raise ValueError('invalid ELF interpreter')
            interpreters.append(raw[:-1].decode('utf-8', errors='strict'))
        elif ptype == 2:
            dynamic.append((offset, filesz))
    if not loads or len(interpreters) > 1 or len(dynamic) > 1:
        raise ValueError('invalid ELF load/interpreter/dynamic segment count')
    if entry and not any(p['flags'] & 1 and p['address'] <= entry < p['address'] + p['memorySize'] for p in loads):
        raise ValueError('ELF entry is outside executable segments')
    tags = []
    for offset, length in dynamic:
        fmt, width = ('<iI', 8) if bits == 32 else ('<qQ', 16)
        if length % width:
            raise ValueError('unaligned ELF dynamic segment')
        for pos in range(offset, offset + length, width):
            tag, value = struct.unpack_from(fmt, data, pos)
            if tag == 0:
                break
            tags.append((tag, value))
        else:
            raise ValueError('unterminated ELF dynamic segment')
    strings = [(tag, value) for tag, value in tags if tag in (1, 14, 15, 29)]
    decoded = []
    if strings:
        tables = [value for tag, value in tags if tag == 5]
        sizes = [value for tag, value in tags if tag == 10]
        if len(tables) != 1 or len(sizes) != 1:
            raise ValueError('missing or ambiguous ELF dynamic string table')
        start, length = tables[0], sizes[0]
        segments = [p for p in loads if p['address'] <= start and start + length <= p['address'] + p['fileSize']]
        if len(segments) != 1:
            raise ValueError('ELF string table is outside file-backed segments')
        offset = segments[0]['offset'] + start - segments[0]['address']
        table = data[offset:offset + length]
        for tag, value in strings:
            end = table.find(b'\0', value)
            if value >= length or end < 0:
                raise ValueError('invalid ELF dynamic string offset')
            decoded.append((tag, table[value:end].decode('utf-8', errors='strict')))
    needed = [value for tag, value in decoded if tag == 1]
    interpreter = interpreters[0] if interpreters else None
    if interpreter in ('/system/bin/linker', '/system/bin/linker64'):
        environment = 'android'
    elif interpreter:
        environment = 'non-android'
    elif 'libc.so.6' in needed:
        environment = 'non-android'
    elif 'libc.so' in needed:
        environment = 'android'
    else:
        environment = 'unclassified'
    return {
        'bits': bits, 'machine': machine, 'architecture': MACHINES.get(machine, f'elf-machine-{machine}'),
        'type': kind, 'entry': entry, 'interpreter': interpreter, 'environment': environment,
        'needed': needed, 'soname': [value for tag, value in decoded if tag == 14],
        'rpath': [value for tag, value in decoded if tag == 15],
        'runpath': [value for tag, value in decoded if tag == 29],
        'loadSegments': loads,
        'elf16kAligned': all(p['alignment'] >= 16384 and (p['address'] - p['offset']) % 16384 == 0 for p in loads),
        'writableExecutableSegments': any(p['flags'] & 3 == 3 for p in loads),
    }


def normalized_path(parts):
    result = []
    for part in parts:
        if part in ('', '.'):
            continue
        if part == '..':
            if not result:
                raise ValueError('link escapes snapshot root')
            result.pop()
        else:
            result.append(part)
    return '/'.join(result)


def resolve_entry(entries, path, prefix, guest=False):
    """Resolve links lexically, including directory links; never touch host paths."""
    path = normalized_path(PurePosixPath(path).parts)
    prefixes = {prefix}
    for source, alias in (('/data/user/0/', '/data/data/'), ('/data/data/', '/data/user/0/')):
        if prefix.startswith(source):
            prefixes.add(alias + prefix[len(source):])
    seen = set()
    for _ in range(64):
        if path in seen:
            return {'status': 'cycle', 'target': path}
        seen.add(path)
        parts = path.split('/')
        for index in range(len(parts)):
            current = '/'.join(parts[:index + 1])
            item = entries.get(current)
            if item and item['kind'] == 'symlink':
                target = item['target']
                if target.startswith('/'):
                    matched = next((p for p in prefixes if target == p or target.startswith(p + '/')), None)
                    if guest:
                        target = target.lstrip('/')
                    elif matched:
                        target = 'usr' + target[len(matched):]
                    else:
                        return {'status': 'external', 'target': target}
                else:
                    target = '/'.join(parts[:index] + [target])
                try:
                    path = normalized_path(PurePosixPath(target).parts + tuple(parts[index + 1:]))
                except ValueError:
                    return {'status': 'escape', 'target': item['target']}
                break
        else:
            return {'status': 'resolved' if path in entries else 'missing', 'target': path}
    return {'status': 'too-many-links', 'target': path}


def inventory(root, abi, prefix=DEFAULT_PREFIX, required=None, layout='android-snapshot'):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('snapshot root must be a real directory')
    if abi not in ABI_MACHINE:
        raise ValueError('unsupported ABI')
    if layout not in ('android-snapshot', 'linux-rootfs', 'linux-node'):
        raise ValueError('unsupported runtime layout')
    guest = layout != 'android-snapshot'
    if not prefix.startswith('/') or str(PurePosixPath(prefix)) != prefix or '..' in PurePosixPath(prefix).parts or prefix.endswith('/'):
        raise ValueError('prefix must be an absolute normalized device path')
    entries = {}

    def walk(directory):
        for path in sorted(directory.iterdir()):
            relative = path.relative_to(root).as_posix()
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                entries[relative] = {'kind': 'symlink', 'target': os.readlink(path)}
            elif stat.S_ISDIR(mode):
                entries[relative] = {'kind': 'directory'}
                walk(path)
            elif stat.S_ISREG(mode):
                item = {'kind': 'data', 'size': path.stat().st_size, 'executable': bool(mode & 0o111)}
                with path.open('rb') as stream:
                    header = stream.read(4096)
                if header.startswith(b'\x7fELF'):
                    try:
                        item.update(kind='elf', elf=elf_metadata(path.read_bytes()))
                    except (ValueError, UnicodeError, struct.error) as error:
                        raise ValueError(f'{relative}: {error}') from error
                    item['sha256'] = sha256_file(path)
                    # Full path hash avoids basename collisions (git helpers, bundled tools).
                    if item['elf']['type'] != 1 and not guest:
                        item['proposedApkName'] = 'libpocketharness_payload_' + hashlib.sha256(relative.encode()).hexdigest() + '.so'
                    item['migrationStatus'] = 'build-input' if item['elf']['type'] == 1 else ('guest-payload' if guest else 'pending')
                elif header.startswith(b'#!'):
                    item.update(kind='script', shebang=header.split(b'\n', 1)[0].decode('utf-8', errors='replace'), sha256=sha256_file(path))
                elif item['executable']:
                    item.update(kind='unclassified-executable', sha256=sha256_file(path))
                entries[relative] = item
            else:
                raise ValueError(f'{relative}: unsupported special filesystem entry')

    walk(root)
    commands = {}
    locations = {
        'android-snapshot': {'node': ['usr/bin/node'], 'bash': ['usr/bin/bash']},
        'linux-rootfs': {'bash': ['usr/bin/bash', 'bin/bash']},
        'linux-node': {'node': ['bin/node']},
    }[layout]
    for name in locations if required is None else required:
        if not name or name in ('.', '..') or '/' in name:
            raise ValueError('required command must be a single filename')
        candidates = locations.get(name, [f'usr/bin/{name}'])
        resolutions = [resolve_entry(entries, path, prefix, guest) for path in candidates]
        result = next((value for value in resolutions if value['status'] == 'resolved'), resolutions[0])
        item = entries.get(result['target'], {})
        metadata = item.get('elf', {})
        if (result['status'] != 'resolved' or item.get('kind') != 'elf' or not item.get('executable')
                or metadata.get('machine') != ABI_MACHINE[abi] or metadata.get('bits') != 64
                or not metadata.get('entry')
                or metadata.get('environment') == ('android' if guest else 'non-android')):
            raise ValueError(f'required command {name} is not a matching executable ELF: {canonical(result)}')
        commands[name] = result['target']
    payloads = []
    counts = {}
    for path, item in sorted(entries.items()):
        counts[item['kind']] = counts.get(item['kind'], 0) + 1
        if item['kind'] in ('directory', 'data'):
            continue
        row = dict(path=path, **item)
        if item['kind'] == 'symlink':
            row['resolution'] = resolve_entry(entries, path, prefix, guest)
        payloads.append(row)
    if not counts.get('elf'):
        raise ValueError('native inventory is empty')
    return dict(schemaVersion=1, phase='inventory-only', abi=abi, layout=layout, devicePrefix=None if guest else prefix,
                requiredCommands=commands, counts=counts, payloads=payloads,
                inventorySha256=hashlib.sha256(canonical(payloads).encode()).hexdigest())


def apk_inventory(apk, abi):
    """Inspect installed-code candidates too; snapshot-only scans miss PRoot/JNI."""
    apk = Path(apk)
    if abi not in ABI_MACHINE or apk.is_symlink() or not apk.is_file():
        raise ValueError('APK must be a regular file with a supported ABI')
    directory = 'arm64-v8a' if abi == 'arm64' else 'x86_64'
    rows = []
    with zipfile.ZipFile(apk) as archive:
        names = [entry.filename for entry in archive.infolist()]
        if len(names) != len(set(names)):
            raise ValueError('APK has duplicate ZIP members')
        for entry in archive.infolist():
            if not entry.filename.startswith('lib/') or entry.is_dir():
                continue
            parts = entry.filename.split('/')
            if (len(parts) != 3 or parts[1] != directory
                    or not parts[2].startswith('lib') or not parts[2].endswith('.so')):
                raise ValueError(f'unexpected APK native member: {entry.filename}')
            file_type = stat.S_IFMT(entry.external_attr >> 16)
            if file_type not in (0, stat.S_IFREG):
                raise ValueError(f'APK native member is not regular: {entry.filename}')
            data = archive.read(entry)
            metadata = elf_metadata(data)
            if metadata['machine'] != ABI_MACHINE[abi] or metadata['bits'] != 64 or metadata['type'] == 1:
                raise ValueError(f'APK native member has wrong ABI/type: {entry.filename}')
            rows.append(dict(path=entry.filename, size=len(data), sha256=hashlib.sha256(data).hexdigest(),
                             elf=metadata, zipCompression=entry.compress_type))
        # An APK may legitimately keep every native payload in its snapshot
        # (e.g. existing x86_64 builds without PRoot/JNI). The snapshot inventory
        # still enforces its own nonempty/required-command checks. Missing known
        # PRoot/JNI members remain the responsibility of their packaging gates.
        snapshot = hashlib.sha256()
        with archive.open('assets/snapshot.tar.xz') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                snapshot.update(chunk)
    return dict(snapshotArchiveSha256=snapshot.hexdigest(), apkNativePayloads=sorted(rows, key=lambda row: row['path']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot_root', nargs='?')
    parser.add_argument('report', nargs='?')
    parser.add_argument('--abi', choices=ABI_MACHINE)
    parser.add_argument('--prefix', default=DEFAULT_PREFIX)
    parser.add_argument('--layout', choices=('android-snapshot', 'linux-rootfs', 'linux-node'), default='android-snapshot')
    parser.add_argument('--apk', help='APK whose snapshot was extracted to snapshot_root; also inventory its native members')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        import unittest
        suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent), pattern='test_native_runtime_inventory.py')
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        if result.testsRun == 0 or not result.wasSuccessful():
            raise SystemExit(1)
        return
    if not args.snapshot_root or not args.report or not args.abi:
        parser.error('snapshot_root, report and --abi are required')
    report = inventory(args.snapshot_root, args.abi, args.prefix, layout=args.layout)
    if args.apk:
        report.update(apk_inventory(args.apk, args.abi))
    destination = Path(args.report)
    # An audit must not add itself to, or overwrite anything in, its input tree.
    if destination.resolve().is_relative_to(Path(args.snapshot_root).resolve()):
        raise ValueError('report must be outside snapshot root')
    if destination.is_symlink():
        raise ValueError('report must not be a symlink')
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f"PASS native inventory ({args.abi}): {report['counts']['elf']} ELF files; migration pending")


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(f'native runtime inventory: {error}', file=sys.stderr)
        raise SystemExit(1)
