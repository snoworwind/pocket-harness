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
            self.assertTrue(MODULE._is_pruned_dir(Path('prebuilds') / name, 'arm64'))
        self.assertFalse(MODULE._is_pruned_dir(Path('prebuilds/linux-arm64'), 'arm64'))
        self.assertFalse(MODULE._is_pruned_dir(Path('prebuilds/linux-x64'), 'x86_64'))
        self.assertTrue(MODULE._is_pruned_dir(Path('@openai+codex@1-linux-arm64'), 'x86_64'))

    def test_system_addon_package_name_is_pinned(self):
        self.assertEqual(MODULE.ABI_CONFIG['arm64']['addon'], '@deepseek-ai/node-addon-system-linux-arm64')


if __name__ == '__main__':
    unittest.main()
