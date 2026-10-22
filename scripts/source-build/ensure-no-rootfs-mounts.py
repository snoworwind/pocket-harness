#!/usr/bin/env python3
"""Refuse destructive rootfs cleanup when any mount exists at or below it."""
from __future__ import annotations

import os
from pathlib import Path
import re
import sys


def decode_mountinfo_path(value: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)


def mounted_paths_below(root: str, mountinfo: str) -> list[str]:
    root_path = os.path.realpath(root)
    if root_path == os.path.sep:
        raise ValueError("refusing to inspect the filesystem root")
    matches = []
    for line in mountinfo.splitlines():
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) < 6 or "-" not in fields:
            raise ValueError("malformed /proc/self/mountinfo; refusing cleanup")
        mount_path = os.path.normpath(decode_mountinfo_path(fields[4]))
        try:
            common = os.path.commonpath((root_path, mount_path))
        except ValueError:
            continue
        if common == root_path:
            matches.append(mount_path)
    return sorted(set(matches))


def assert_no_mounts(root: str, mountinfo_path: str = "/proc/self/mountinfo") -> None:
    if os.path.islink(root):
        raise ValueError("rootfs cleanup target is a symlink")
    if not os.path.isdir(root):
        raise ValueError("rootfs cleanup target must be an existing directory")
    try:
        mountinfo = Path(mountinfo_path).read_text(encoding="utf-8")
    except OSError as error:
        raise ValueError(f"cannot read mount table; refusing cleanup: {error}") from error
    mounted = mounted_paths_below(root, mountinfo)
    if mounted:
        raise ValueError("rootfs contains mount points; refusing cleanup: " + ", ".join(mounted))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: ensure-no-rootfs-mounts.py ROOTFS", file=sys.stderr)
        return 2
    try:
        assert_no_mounts(argv[1])
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
