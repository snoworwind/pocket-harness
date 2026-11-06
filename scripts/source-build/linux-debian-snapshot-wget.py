#!/usr/bin/env python3
"""Retry unavailable pinned Debian snapshot package blobs from the official mirror.

debootstrap verifies downloaded package bytes against the SHA-256 and size in
the signed Packages index. This shim never changes the source of index or
Release metadata; it only maps a failed package blob URL to deb.debian.org.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit


SNAPSHOT_PACKAGE = re.compile(
    r"^/archive/debian/[0-9]{8}T[0-9]{6}Z/(pool/(?:main|contrib|non-free|non-free-firmware)/.+\.deb)$"
)
OFFICIAL_DEBIAN = "https://deb.debian.org/debian/"


def fallback_url(url: str) -> str | None:
    """Return the official mirror URL only for a pinned-snapshot .deb blob."""
    try:
        parsed = urlsplit(url)
        decoded_path = unquote(parsed.path)
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.netloc != "snapshot.debian.org":
        return None
    if parsed.query or parsed.fragment:
        return None
    if decoded_path.count("/") != parsed.path.count("/"):
        return None
    if any(segment in {".", ".."} for segment in decoded_path.split("/")):
        return None
    match = SNAPSHOT_PACKAGE.fullmatch(parsed.path)
    if not match:
        return None
    return OFFICIAL_DEBIAN + match.group(1)


def run_wget(args: list[str], real_wget: str) -> int:
    """Try the requested URL, then the safe package-only mirror fallback."""
    if not args or not args[-1].startswith(("https://", "http://", "ftp://")):
        print("debootstrap-wget: expected a final URL argument", file=sys.stderr)
        return 2

    original_status = subprocess.call([real_wget, *args])
    if original_status == 0:
        return 0

    alternative = fallback_url(args[-1])
    if alternative is None:
        return original_status

    print(
        "debootstrap-wget: snapshot package fetch failed; retrying from the official Debian mirror; "
        "debootstrap will verify the bytes against the signed index",
        file=sys.stderr,
    )
    return subprocess.call([real_wget, *args[:-1], alternative])


def self_test() -> int:
    package_url = (
        "https://snapshot.debian.org/archive/debian/20261016T000000Z/"
        "pool/main/a/apt/apt_3.0.3_arm64.deb"
    )
    expected = "https://deb.debian.org/debian/pool/main/a/apt/apt_3.0.3_arm64.deb"
    assert fallback_url(package_url) == expected
    for rejected in (
        "https://snapshot.debian.org/archive/debian/20261016T000000Z/dists/trixie/InRelease",
        "https://snapshot.debian.org/archive/debian/20261016T000000Z/dists/trixie/main/binary-arm64/Packages.xz",
        "http://snapshot.debian.org/archive/debian/20261016T000000Z/pool/main/a/apt/apt.deb",
        "https://example.com/archive/debian/20261016T000000Z/pool/main/a/apt/apt.deb",
        "https://snapshot.debian.org/archive/debian/20261016T000000Z/pool/main/a/../apt/apt.deb",
    ):
        assert fallback_url(rejected) is None, f"unsafe fallback accepted: {rejected}"

    with tempfile.TemporaryDirectory(prefix="debian-wget-self-test-") as temp:
        root = Path(temp)
        log = root / "calls.jsonl"
        fake_wget = root / "fake-wget"
        fake_wget.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "from urllib.parse import urlsplit\n"
            "url = sys.argv[-1]\n"
            "with open(os.environ['POCKET_WGET_SELF_TEST_LOG'], 'a', encoding='utf-8') as f:\n"
            "    f.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "sys.exit(23 if urlsplit(url).hostname == 'snapshot.debian.org' else 0)\n",
            encoding="utf-8",
        )
        fake_wget.chmod(0o755)
        previous = os.environ.get("POCKET_WGET_SELF_TEST_LOG")
        previous_real_wget = os.environ.get("DEBOOTSTRAP_REAL_WGET")
        os.environ["POCKET_WGET_SELF_TEST_LOG"] = str(log)
        os.environ["DEBOOTSTRAP_REAL_WGET"] = str(fake_wget)
        try:
            positive = main(["-nv", "-O", str(root / "apt.deb"), package_url])
            assert positive == 0, "eligible package fallback should succeed"
            calls = log.read_text(encoding="utf-8").splitlines()
            assert len(calls) == 2, "eligible package should try both sources"
            log.write_text("", encoding="utf-8")
            negative = main(
                ["-nv", "-O", str(root / "Packages"),
                 "https://snapshot.debian.org/archive/debian/20261016T000000Z/"
                 "dists/trixie/main/binary-arm64/Packages.xz"]
            )
            calls = log.read_text(encoding="utf-8").splitlines()
            assert negative == 23 and len(calls) == 1, "metadata failure must not fall back"
        finally:
            if previous is None:
                os.environ.pop("POCKET_WGET_SELF_TEST_LOG", None)
            else:
                os.environ["POCKET_WGET_SELF_TEST_LOG"] = previous
            if previous_real_wget is None:
                os.environ.pop("DEBOOTSTRAP_REAL_WGET", None)
            else:
                os.environ["DEBOOTSTRAP_REAL_WGET"] = previous_real_wget
    print("Debian snapshot wget shim self-test passed, including metadata negative control")
    return 0


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        try:
            return self_test()
        except AssertionError as error:
            print(f"Debian snapshot wget shim self-test failed: {error}", file=sys.stderr)
            return 1
    if not argv:
        print("usage: wget [wget arguments] URL | --self-test", file=sys.stderr)
        return 2
    real_wget = os.environ.get("DEBOOTSTRAP_REAL_WGET", "")
    if not real_wget or not os.path.isabs(real_wget) or not os.access(real_wget, os.X_OK):
        print("debootstrap-wget: DEBOOTSTRAP_REAL_WGET must be an executable absolute path", file=sys.stderr)
        return 2
    return run_wget(argv, real_wget)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
