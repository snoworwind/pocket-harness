import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("linux-debian-snapshot-wget.py")
SPEC = importlib.util.spec_from_file_location("linux_debian_snapshot_wget", SCRIPT)
SHIM = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SHIM)


class DebianSnapshotWgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="debian-wget-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / "calls.jsonl"
        self.fake_wget = self.root / "fake-wget"
        self.fake_wget.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "from urllib.parse import urlsplit\n"
            "url = sys.argv[-1]\n"
            "with open(os.environ['POCKET_WGET_TEST_LOG'], 'a', encoding='utf-8') as f:\n"
            "    f.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "failed = set(os.environ.get('POCKET_WGET_FAIL_HOSTS', '').split(','))\n"
            "sys.exit(23 if urlsplit(url).hostname in failed else 0)\n",
            encoding="utf-8",
        )
        self.fake_wget.chmod(0o755)
        self.previous_log = os.environ.get("POCKET_WGET_TEST_LOG")
        self.previous_fail_hosts = os.environ.get("POCKET_WGET_FAIL_HOSTS")
        os.environ["POCKET_WGET_TEST_LOG"] = str(self.log)
        self.addCleanup(self.restore_environment)

    def restore_environment(self):
        if self.previous_log is None:
            os.environ.pop("POCKET_WGET_TEST_LOG", None)
        else:
            os.environ["POCKET_WGET_TEST_LOG"] = self.previous_log
        if self.previous_fail_hosts is None:
            os.environ.pop("POCKET_WGET_FAIL_HOSTS", None)
        else:
            os.environ["POCKET_WGET_FAIL_HOSTS"] = self.previous_fail_hosts

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def test_only_snapshot_deb_blobs_map_to_official_pool_path(self):
        source = (
            "https://snapshot.debian.org/archive/debian/20261016T000000Z/"
            "pool/main/a/apt/apt_3.0.3_arm64.deb"
        )
        self.assertEqual(
            SHIM.fallback_url(source),
            "https://deb.debian.org/debian/pool/main/a/apt/apt_3.0.3_arm64.deb",
        )

    def test_snapshot_metadata_and_untrusted_urls_have_no_fallback(self):
        urls = (
            "https://snapshot.debian.org/archive/debian/20261016T000000Z/dists/trixie/InRelease",
            "https://snapshot.debian.org/archive/debian/20261016T000000Z/dists/trixie/main/binary-arm64/Packages.xz",
            "http://snapshot.debian.org/archive/debian/20261016T000000Z/pool/main/a/apt/apt.deb",
            "https://example.com/archive/debian/20261016T000000Z/pool/main/a/apt/apt.deb",
            "https://snapshot.debian.org/archive/debian/20261016T000000Z/pool/main/a/../apt/apt.deb",
        )
        for url in urls:
            with self.subTest(url=url):
                self.assertIsNone(SHIM.fallback_url(url))

    def test_failed_package_uses_official_mirror_and_preserves_wget_arguments(self):
        os.environ["POCKET_WGET_FAIL_HOSTS"] = "snapshot.debian.org"
        source = (
            "https://snapshot.debian.org/archive/debian/20261016T000000Z/"
            "pool/main/a/apt/apt_3.0.3_arm64.deb"
        )
        args = ["-U", "debootstrap/test", "-nv", "-O", str(self.root / "apt.deb"), source]
        self.assertEqual(SHIM.run_wget(args, str(self.fake_wget)), 0)
        calls = self.calls()
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], args)
        self.assertEqual(
            calls[1],
            [*args[:-1], "https://deb.debian.org/debian/pool/main/a/apt/apt_3.0.3_arm64.deb"],
        )

    def test_negative_control_metadata_failure_does_not_retry_another_source(self):
        os.environ["POCKET_WGET_FAIL_HOSTS"] = "snapshot.debian.org"
        url = "https://snapshot.debian.org/archive/debian/20261016T000000Z/dists/trixie/InRelease"
        self.assertEqual(SHIM.run_wget(["-O", str(self.root / "InRelease"), url], str(self.fake_wget)), 23)
        self.assertEqual(len(self.calls()), 1)

    def test_failed_fallback_returns_mirror_failure(self):
        os.environ["POCKET_WGET_FAIL_HOSTS"] = "snapshot.debian.org,deb.debian.org"
        url = (
            "https://snapshot.debian.org/archive/debian/20261016T000000Z/"
            "pool/main/a/apt/apt_3.0.3_arm64.deb"
        )
        self.assertEqual(SHIM.run_wget(["-O", str(self.root / "apt.deb"), url], str(self.fake_wget)), 23)
        self.assertEqual(len(self.calls()), 2)


if __name__ == "__main__":
    unittest.main()
