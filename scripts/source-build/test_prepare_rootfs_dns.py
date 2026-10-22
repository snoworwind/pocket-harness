import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "vendor/bionilux/scripts/prepare-rootfs.sh"


class PrepareRootfsDnsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prepare-rootfs-dns-")
        self.rootfs = pathlib.Path(self.temp.name) / "rootfs"
        (self.rootfs / "etc").mkdir(parents=True)
        (self.rootfs / "etc/resolv.conf").write_text("nameserver 203.0.113.53\n")

    def tearDown(self):
        self.temp.cleanup()

    @unittest.skipUnless(subprocess.run(["stat", "-c", "%a", "."], capture_output=True).returncode == 0,
                         "prepare-rootfs requires GNU stat")
    def test_no_dns_removes_previous_network_resolver(self):
        result = subprocess.run(
            ["sh", str(SCRIPT), "--rootfs", str(self.rootfs), "--relative-links", "--no-dns"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        resolver = (self.rootfs / "etc/resolv.conf").read_text()
        self.assertNotIn("nameserver", resolver)
        self.assertIn("No usable Android DNS resolver is available", resolver)

    @unittest.skipUnless(subprocess.run(["stat", "-c", "%a", "."], capture_output=True).returncode == 0,
                         "prepare-rootfs requires GNU stat")
    def test_dns_mode_replaces_previous_resolver(self):
        result = subprocess.run(
            ["sh", str(SCRIPT), "--rootfs", str(self.rootfs), "--relative-links", "--dns", "1.1.1.1 2001:4860:4860::8888"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        resolver = (self.rootfs / "etc/resolv.conf").read_text()
        self.assertEqual(resolver.count("nameserver "), 2)
        self.assertIn("nameserver 1.1.1.1", resolver)
        self.assertIn("nameserver 2001:4860:4860::8888", resolver)
        self.assertNotIn("203.0.113.53", resolver)

    def test_dns_and_no_dns_are_mutually_exclusive(self):
        result = subprocess.run(
            ["sh", str(SCRIPT), "--rootfs", str(self.rootfs), "--dns", "1.1.1.1", "--no-dns"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mutually exclusive", result.stderr)


if __name__ == "__main__":
    unittest.main()
