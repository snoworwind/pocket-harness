import os
import pathlib
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "vendor/linux-proot/compat/termfold_compat.c"


@unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("cc"),
                     "compatibility preload integration requires Linux and cc")
class ProotCompatTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="proot-compat-")
        cls.root = pathlib.Path(cls.temp.name)
        cls.library = cls.root / "libpocket-linux-compat.so"
        subprocess.run([
            "cc", "-shared", "-fPIC", "-O2", "-Wall", "-Wextra", "-Werror",
            "-DDSH_LINK_TEST_FORCE_DENIED", "-DDSH_LINK_COPY_MAX_BYTES=1048576",
            "-o", str(cls.library), str(SOURCE), "-ldl",
        ], check=True)
        cls.fail_library = cls.root / "libpocket-linux-compat-fail.so"
        subprocess.run([
            "cc", "-shared", "-fPIC", "-O2", "-Wall", "-Wextra", "-Werror",
            "-DDSH_LINK_TEST_FORCE_DENIED", "-DDSH_LINK_COPY_MAX_BYTES=1048576",
            "-DDSH_LINK_TEST_FAIL_AFTER_BYTES=64",
            "-o", str(cls.fail_library), str(SOURCE), "-ldl",
        ], check=True)
        cls.stop_library = cls.root / "libpocket-linux-compat-stop.so"
        subprocess.run([
            "cc", "-shared", "-fPIC", "-O2", "-Wall", "-Wextra", "-Werror",
            "-DDSH_LINK_TEST_FORCE_DENIED", "-DDSH_LINK_COPY_MAX_BYTES=1048576",
            "-DDSH_LINK_TEST_STOP_AFTER_BYTES=64",
            "-o", str(cls.stop_library), str(SOURCE), "-ldl",
        ], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def run_python(self, code, *args, library=None):
        env = dict(os.environ)
        env["LD_PRELOAD"] = str(library or self.library)
        return subprocess.run([sys.executable, "-c", code, *map(str, args)],
                              env=env, capture_output=True, text=True)

    def test_refused_regular_hard_link_becomes_independent_copy(self):
        source = self.root / "source-data"
        target = self.root / "target-data"
        source.write_bytes(b"copied through the TermFold compatibility shim\n")
        source.chmod(0o640)
        os.utime(source, (1_700_000_000, 1_700_000_000))
        result = self.run_python(
            "import os,sys; os.link(sys.argv[1],sys.argv[2]); a=os.stat(sys.argv[1]); b=os.stat(sys.argv[2]); "
            "assert a.st_ino != b.st_ino and b.st_nlink == 1 and a.st_mode == b.st_mode and a.st_mtime == b.st_mtime",
            source, target,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(target.read_bytes(), source.read_bytes())

    def test_existing_target_and_directory_keep_link_semantics(self):
        source = self.root / "existing-source"
        target = self.root / "existing-target"
        source.write_text("source")
        target.write_text("untouched")
        directory = self.root / "directory-source"
        directory.mkdir(exist_ok=True)
        result = self.run_python(
            "import errno,os,sys; "
            "\ntry: os.link(sys.argv[1],sys.argv[2]); raise AssertionError('EEXIST expected')\n"
            "except FileExistsError: pass\n"
            "try: os.link(sys.argv[3],sys.argv[4]); raise AssertionError('directory link expected to fail')\n"
            "except OSError as e: assert e.errno == errno.EPERM",
            source, target, directory, self.root / "directory-target",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(target.read_text(), "untouched")
        self.assertFalse((self.root / "directory-target").exists())

    def test_symlink_source_stays_a_symlink_and_missing_source_keeps_enoent(self):
        source = self.root / "link-target"
        link_source = self.root / "source-link"
        link_copy = self.root / "copy-link"
        source.write_text("referent")
        link_source.symlink_to(source.name)
        result = self.run_python(
            "import errno,os,sys; os.link(sys.argv[1],sys.argv[2],follow_symlinks=False); "
            "assert os.path.islink(sys.argv[2]) and os.readlink(sys.argv[2]) == os.readlink(sys.argv[1]); "
            "\ntry: os.link(sys.argv[3],sys.argv[4]); raise AssertionError('ENOENT expected')\n"
            "except FileNotFoundError: pass",
            link_source, link_copy, self.root / "missing", self.root / "missing-copy",
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_copy_size_cap_fails_before_creating_partial_destination(self):
        source = self.root / "oversized-sparse-source"
        target = self.root / "oversized-copy"
        with source.open("wb") as stream:
            stream.truncate(1_048_577)
        result = self.run_python(
            "import errno,os,sys; "
            "\ntry: os.link(sys.argv[1],sys.argv[2]); raise AssertionError('EFBIG expected')\n"
            "except OSError as e: assert e.errno == errno.EFBIG, e",
            source, target,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(target.exists())
        self.assertFalse(list(self.root.glob(".pocket-harness-link-*")))

    def test_copy_error_never_publishes_partial_destination(self):
        source = self.root / "write-error-source"
        target = self.root / "write-error-target"
        source.write_bytes(b"copy error fixture" * 20_000)
        result = self.run_python(
            "import errno,os,sys; "
            "\ntry: os.link(sys.argv[1],sys.argv[2]); raise AssertionError('EIO expected')\n"
            "except OSError as e: assert e.errno == errno.EIO, e",
            source, target, library=self.fail_library,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(target.exists())
        self.assertFalse(list(self.root.glob(".pocket-harness-link-*")))

    def test_killed_copy_never_publishes_partial_destination(self):
        source = self.root / "interrupted-source"
        target = self.root / "interrupted-target"
        source.write_bytes(b"interrupted copy fixture" * 20_000)
        env = dict(os.environ)
        env["LD_PRELOAD"] = str(self.stop_library)
        process = subprocess.Popen(
            [sys.executable, "-c", "import os,sys; os.link(sys.argv[1],sys.argv[2])", str(source), str(target)],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        stopped = False
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            waited, status = os.waitpid(process.pid, os.WNOHANG | os.WUNTRACED)
            if waited:
                stopped = os.WIFSTOPPED(status)
                break
            time.sleep(0.01)
        if not stopped:
            process.kill()
            process.communicate(timeout=5)
        self.assertTrue(stopped, "copy test process did not stop inside the temporary-file write")
        self.assertFalse(target.exists())
        temporary = list(self.root.glob(".pocket-harness-link-*"))
        self.assertEqual(len(temporary), 1)
        self.assertEqual(temporary[0].read_bytes(), source.read_bytes()[:64])
        process.send_signal(signal.SIGKILL)
        process.communicate(timeout=5)
        self.assertEqual(process.returncode, -signal.SIGKILL)
        self.assertFalse(target.exists())
        temporary[0].unlink()


if __name__ == "__main__":
    unittest.main()
