"""Regression wrapper for the guest engine tree packager."""
import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    'package_guest_engine', Path(__file__).with_name('package-guest-engine.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PackageGuestEngineTest(unittest.TestCase):
    def test_self_test_passes(self):
        self.assertEqual(MODULE.self_test(), 0)

    def test_android_and_desktop_variants_are_pruned(self):
        for name in ('android-arm64', 'darwin-arm64', 'win32-x64', 'linux-x64'):
            self.assertIn(name, MODULE.PRUNE_DIRS)
        self.assertNotIn('linux-arm64', MODULE.PRUNE_DIRS)

    def test_system_addon_package_name_is_pinned(self):
        self.assertEqual(MODULE.ADDON_PACKAGE, '@deepseek-ai/node-addon-system-linux-arm64')


if __name__ == '__main__':
    unittest.main()
