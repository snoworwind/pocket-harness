#!/usr/bin/env python3
"""Extract a verified base archive into a new staging directory, never a repo.

The outer manifest/hash check belongs to engine-base.mjs. This layer separately
rejects traversal, special files, hardlinks and writes beneath symlink members.
"""
import pathlib
import posixpath
import sys
import tarfile

TOPS = {'engine-deploy', 'engine-overlay', 'harness-source', 'marketplace', 'component-sources', 'reports'}


def validate(members):
    names = set()
    links = set()
    for member in members:
        name = member.name.removeprefix('./').rstrip('/')
        if name in ('', '.') and member.isdir():
            continue
        path = pathlib.PurePosixPath(name)
        if path.is_absolute() or any(part in ('', '.', '..') for part in name.split('/')) or '\\' in name or not path.parts or path.parts[0] not in TOPS:
            raise ValueError('unsafe base member: ' + member.name)
        if name in names:
            raise ValueError('duplicate base member: ' + name)
        names.add(name)
        if not (member.isdir() or member.isfile() or member.issym()):
            raise ValueError('unsupported base member: ' + name)
        if member.issym():
            target = member.linkname
            resolved = posixpath.normpath(posixpath.join(str(path.parent), target))
            if not target or target.startswith('/') or '\\' in target or resolved.split('/')[0] != path.parts[0]:
                raise ValueError('escaped base symlink: ' + name)
            links.add(name)
    for name in names:
        if any(str(parent) in links for parent in pathlib.PurePosixPath(name).parents):
            raise ValueError('base member under symlink: ' + name)


def extract(archive, destination):
    destination = pathlib.Path(destination)
    if destination.is_symlink() or (destination.exists() and any(destination.iterdir())):
        raise ValueError('base extraction requires a new empty directory')
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, 'r:') as source:
        members = source.getmembers()
        validate(members)
        source.extractall(destination, members=members, filter='data')
        for member in members:
            if member.issym():
                path = destination / member.name
                path.resolve(strict=True).relative_to((destination / pathlib.PurePosixPath(member.name.removeprefix('./')).parts[0]).resolve())


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: base-archive.py archive.tar empty-directory')
    extract(sys.argv[1], sys.argv[2])
