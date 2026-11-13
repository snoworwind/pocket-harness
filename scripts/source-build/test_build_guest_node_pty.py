"""Regression wrapper for the guest node-pty cross-build tool."""
import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    'build_guest_node_pty', Path(__file__).with_name('build-guest-node-pty.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BuildGuestNodePtyTest(unittest.TestCase):
    def test_self_test_passes(self):
        self.assertEqual(MODULE.self_test(), 0)

    def test_cpp_addons_may_link_the_cpp_runtime(self):
        allowed = MODULE.addons.CPP_NEEDED
        for library in ('libstdc++.so.6', 'libgcc_s.so.1', 'libc.so.6'):
            self.assertIn(library, allowed)

    def test_plain_addons_stay_on_the_c_subset(self):
        for library in ('libstdc++.so.6', 'libgcc_s.so.1'):
            self.assertNotIn(library, MODULE.addons.ALLOWED_NEEDED)


if __name__ == '__main__':
    unittest.main()
