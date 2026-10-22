#!/usr/bin/env python3
"""Shared validation for the authenticated Termux package index and payload paths."""
from __future__ import annotations

from pathlib import PurePosixPath
import re
import subprocess


TERMUX_POOL_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
TERMUX_DEB_FILENAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+~:-]*\.deb$")


def safe_termux_package_filename(filename: str) -> PurePosixPath:
    """Allow only normalized pool paths, with Debian epochs in the .deb basename."""
    parts = filename.split("/") if isinstance(filename, str) else []
    if (len(parts) < 4 or parts[:2] != ["pool", "main"]
            or any(part in ("", ".", "..") for part in parts)
            or any(not TERMUX_POOL_COMPONENT.fullmatch(part) for part in parts[:-1])
            or not TERMUX_DEB_FILENAME.fullmatch(parts[-1])):
        raise ValueError(f"unsafe Termux package filename: {filename}")
    return PurePosixPath(*parts)


def _version_satisfies(actual: str, operator: str, required: str) -> bool:
    operators = {"<<": "lt", "<=": "le", "=": "eq", ">=": "ge", ">>": "gt"}
    if operator not in operators:
        raise ValueError(f"unsupported Debian version operator: {operator}")
    result = subprocess.run(["dpkg", "--compare-versions", actual, operators[operator], required],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode not in (0, 1):
        raise ValueError(f"dpkg could not compare package versions {actual!r} and {required!r}")
    return result.returncode == 0


def _compare_versions(left: str, right: str) -> int:
    if _version_satisfies(left, ">>", right):
        return 1
    if _version_satisfies(left, "<<", right):
        return -1
    return 0


def select_package_records(stanzas) -> dict[str, dict]:
    """Choose the newest usable AArch64 record, preferring native arch on version ties."""
    selected = {}
    for record in stanzas:
        name = record.get("Package")
        version = record.get("Version")
        architecture = record.get("Architecture")
        if not isinstance(name, str) or not name or not isinstance(version, str) or not version:
            raise ValueError("signed Termux package stanza has no package name or version")
        if architecture not in ("aarch64", "all"):
            continue

        current = selected.get(name)
        if current is None:
            selected[name] = record
            continue
        comparison = _compare_versions(version, current["Version"])
        if comparison > 0:
            selected[name] = record
        elif comparison == 0:
            current_architecture = current.get("Architecture")
            if architecture == "aarch64" and current_architecture == "all":
                selected[name] = record
            elif architecture == current_architecture:
                raise ValueError(
                    f"duplicate signed Termux package candidate: {name}={version} [{architecture}]"
                )
    return selected
