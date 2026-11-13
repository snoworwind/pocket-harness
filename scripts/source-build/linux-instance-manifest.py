#!/usr/bin/env python3
"""Bind compressed assets and the extracted managed trees to the APK manifest."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile


def digest_file(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def archive_tree(path):
    entries = {}
    links = {}
    with tarfile.open(path, 'r:xz') as archive:
        for item in archive:
            name = item.name.removeprefix('./').rstrip('/')
            if name in ('', '.'):
                continue
            parts = PurePosixPath(name).parts
            if name.startswith('/') or '..' in parts or str(PurePosixPath(name)) != name:
                raise ValueError('noncanonical archive member: ' + name)
            if name in entries:
                raise ValueError('duplicate archive member: ' + name)
            for parent in PurePosixPath(name).parents:
                if str(parent) != '.':
                    entries.setdefault(str(parent), ('d', ''))
            if item.isdir():
                entries[name] = ('d', '')
            elif item.issym():
                entries[name] = ('l', item.linkname)
            elif item.isfile():
                entries[name] = ('f', hashlib.file_digest(archive.extractfile(item), 'sha256').hexdigest())
            elif item.islnk():
                links[name] = item.linkname.removeprefix('./')
            else:
                raise ValueError('unsupported managed member: ' + name)
    def resolve(name, seen=()):
        if name in seen:
            raise ValueError('hardlink cycle')
        if name in links:
            result = resolve(links[name], (*seen, name))
            if result[0] != 'f':
                raise ValueError('hardlink is not a file')
            entries[name] = result
        return entries[name]
    for name in links:
        resolve(name)
    # Same depth-first, sibling-sorted order as LinuxFileTree.digest.
    children = {}
    for name in entries:
        children.setdefault(str(PurePosixPath(name).parent), []).append(name)
    digest = hashlib.sha256()
    def visit(parent):
        for name in sorted(children.get(parent, []), key=lambda value: PurePosixPath(value).name):
            kind, body = entries[name]
            digest.update(f'{kind}\0{name}\0{body}\0'.encode())
            if kind == 'd':
                visit(name)
    visit('.')
    return digest.hexdigest()


def build(directory):
    root = Path(directory)
    record = dict(schemaVersion=1, homeSchemaVersion=2, baseId='debian-13-arm64-glibc-2',
                  guestArchitecture='arm64', minimumGlibc='2.41')
    for name in ('rootfs', 'node', 'engine', 'home'):
        path = root / f'{name}.tar.xz'
        record[name + 'Sha256'] = digest_file(path)
        if name in ('rootfs', 'node', 'engine'):
            record[name + 'TreeSha256'] = archive_tree(path)
        with tarfile.open(path, 'r:xz') as archive:
            record[name + 'UnpackedBytes'] = sum(member.size for member in archive if member.isfile())
    (root / 'manifest.json').write_text(json.dumps(record, indent=2) + '\n')
    return record


if __name__ == '__main__':
    build(sys.argv[1])
