import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("ensure-no-rootfs-mounts.py")
SPEC = importlib.util.spec_from_file_location("ensure_no_rootfs_mounts", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
mounted_paths_below = MODULE.mounted_paths_below


class EnsureNoRootfsMountsTest(unittest.TestCase):
    def test_detects_rootfs_and_nested_mounts_with_mountinfo_escaping(self):
        mountinfo = """10 1 0:1 / / rw - ext4 /dev/root rw
11 10 0:2 / /work/rootfs rw - ext4 /dev/data rw
12 11 0:3 / /work/rootfs/dev rw - tmpfs tmpfs rw
13 10 0:4 / /work/rootfs\\040with\\040space/proc rw - proc proc rw
"""
        self.assertEqual(
            mounted_paths_below("/work/rootfs", mountinfo),
            ["/work/rootfs", "/work/rootfs/dev"],
        )
        self.assertEqual(
            mounted_paths_below("/work/rootfs with space", mountinfo),
            ["/work/rootfs with space/proc"],
        )

    def test_does_not_confuse_sibling_prefix_with_descendant(self):
        mountinfo = "11 10 0:2 / /work/rootfs-backup rw - ext4 /dev/data rw\n"
        self.assertEqual(mounted_paths_below("/work/rootfs", mountinfo), [])

    def test_malformed_mountinfo_is_not_treated_as_clean(self):
        with self.assertRaisesRegex(ValueError, "malformed"):
            mounted_paths_below("/work/rootfs", "broken mount record\n")


if __name__ == "__main__":
    unittest.main()
