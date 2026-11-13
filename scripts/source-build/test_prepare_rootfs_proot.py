import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "vendor/linux-proot/scripts/prepare-rootfs.sh"


class PrepareRootfsProotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prepare-rootfs-proot-")
        self.rootfs = pathlib.Path(self.temp.name) / "rootfs"
        (self.rootfs / "etc").mkdir(parents=True)
        (self.rootfs / "etc/resolv.conf").write_text("nameserver 203.0.113.53\n")
        compat = self.rootfs / "opt/pocket-harness/libpocket-linux-compat.so"
        compat.parent.mkdir(parents=True)
        compat.write_bytes(b"fixture preload")
        compat.chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    @unittest.skipUnless(
        subprocess.run(["stat", "-c", "%a", "."], capture_output=True).returncode == 0
        or subprocess.run(["stat", "-f", "%Lp", "."], capture_output=True).returncode == 0,
        "prepare-rootfs requires GNU or BSD stat",
    )
    def test_prepares_proc_dev_sys_and_non_stale_resolver(self):
        result = subprocess.run(["sh", str(SCRIPT), "--rootfs", str(self.rootfs)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for directory in ["dev", "proc", "sys", "dev/shm", "tmp", "var/tmp", "root"]:
            self.assertTrue((self.rootfs / directory).is_dir(), directory)
        self.assertEqual((self.rootfs / "tmp").stat().st_mode & 0o7777, 0o1777)
        resolver = (self.rootfs / "etc/resolv.conf").read_text()
        self.assertNotIn("203.0.113.53", resolver)
        self.assertIn("current Android network", resolver)
        self.assertEqual((self.rootfs / "etc/ld.so.preload").read_text().strip(),
                         "/opt/pocket-harness/libpocket-linux-compat.so")

    def test_verify_refuses_missing_compatibility_preload(self):
        prepared = subprocess.run(["sh", str(SCRIPT), "--rootfs", str(self.rootfs)], capture_output=True, text=True)
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        (self.rootfs / "opt/pocket-harness/libpocket-linux-compat.so").unlink()
        result = subprocess.run(["sh", str(SCRIPT), "--rootfs", str(self.rootfs), "--verify"],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("compatibility preload missing", result.stderr)

    def test_verify_accepts_a_prepared_rootfs_and_never_mutates_it(self):
        prepared = subprocess.run(["sh", str(SCRIPT), "--rootfs", str(self.rootfs)], capture_output=True, text=True)
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        resolver_before = (self.rootfs / "etc/resolv.conf").read_bytes()
        verified = subprocess.run(["sh", str(SCRIPT), "--rootfs", str(self.rootfs), "--verify"],
                                  capture_output=True, text=True)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertEqual((self.rootfs / "etc/resolv.conf").read_bytes(), resolver_before)


if __name__ == "__main__":
    unittest.main()
