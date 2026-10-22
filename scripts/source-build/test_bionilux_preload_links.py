import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
HOOKS = ROOT / "vendor/bionilux/src/preload/hooks.c"
FIXTURE = r"""
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail(const char *message) {
    fprintf(stderr, "%s: %s\n", message, strerror(errno));
    return 1;
}

int main(void) {
    struct stat source, copied;
    if (link("source", "/mountpoint/regular-copy") != 0) return fail("regular link fallback failed");
    if (stat("source", &source) != 0 || stat("/mountpoint/regular-copy", &copied) != 0)
        return fail("cannot stat copied file");
    if (source.st_ino == copied.st_ino && source.st_dev == copied.st_dev) {
        fprintf(stderr, "fallback unexpectedly created a hard link\n");
        return 2;
    }
    if ((copied.st_mode & 07777) != (source.st_mode & 07777)) {
        fprintf(stderr, "fallback did not preserve file mode\n");
        return 3;
    }

    errno = 0;
    if (linkat(AT_FDCWD, "symlink-source", AT_FDCWD, "/mountpoint/symlink-copy", 0) == 0) {
        fprintf(stderr, "linkat unexpectedly copied a symlink source\n");
        return 4;
    }
    if (errno != EXDEV) return fail("symlink source did not preserve the kernel error");
    if (access("/mountpoint/symlink-copy", F_OK) == 0) {
        fprintf(stderr, "failed symlink link left a destination behind\n");
        return 5;
    }
    return 0;
}
"""


@unittest.skipUnless(platform.system() == "Linux", "preload integration test uses Linux ELF and /dev/shm")
class BioniluxPreloadLinksTest(unittest.TestCase):
    def test_regular_hardlink_refusal_copies_but_symlink_refusal_stays_closed(self):
        compiler = shutil.which("cc")
        if not compiler:
            self.skipTest("a C compiler is required")
        shared_memory = Path("/dev/shm")
        if not shared_memory.is_dir():
            self.skipTest("/dev/shm is unavailable")

        with tempfile.TemporaryDirectory(prefix="bionilux-links-") as temporary:
            root = Path(temporary)
            rootfs = root / "rootfs"
            rootfs.mkdir()
            external = Path(tempfile.mkdtemp(prefix="bionilux-links-", dir=shared_memory))
            self.addCleanup(shutil.rmtree, external, True)
            if rootfs.stat().st_dev == external.stat().st_dev:
                self.skipTest("/dev/shm is on the same filesystem as the fixture root")
            (rootfs / "mountpoint").symlink_to(external, target_is_directory=True)
            source = rootfs / "source"
            source.write_text("preserve the original bytes\n")
            source.chmod(0o751)
            (rootfs / "symlink-source").symlink_to("source")

            preload = root / "libbionilux_preload.so"
            binary = root / "link-fixture"
            subprocess.run(
                [compiler, "-shared", "-fPIC", "-O2", "-Wall", "-Wextra", "-Werror",
                 "-o", str(preload), str(HOOKS), "-pthread", "-ldl"],
                check=True,
                capture_output=True,
                text=True,
            )
            source_file = root / "link-fixture.c"
            source_file.write_text(FIXTURE)
            subprocess.run([compiler, "-O2", "-Wall", "-Wextra", "-Werror", "-o", str(binary), str(source_file)],
                           check=True, capture_output=True, text=True)

            environment = {
                "BIONILUX_ROOTFS": str(rootfs),
                "BIONILUX_DEBUG": "1",
                "LD_PRELOAD": str(preload),
            }
            result = subprocess.run([str(binary)], cwd=rootfs, env=environment,
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            copied = external / "regular-copy"
            self.assertEqual(copied.read_text(), source.read_text())
            self.assertIn("link: copied after kernel refusal", result.stderr)
            self.assertFalse((external / "symlink-copy").exists())


if __name__ == "__main__":
    unittest.main()
