"""Regression wrapper for the guest engine tree packager."""
import importlib.util
import unittest
import tempfile
import json
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

    def test_installed_addon_identity_cannot_cross_abis(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            addon = root / 'addon'
            (addon / 'bin/glibc').mkdir(parents=True)
            (addon / 'bin/glibc/system.node').write_bytes(b'fixture')
            for abi in ('arm64', 'x86_64'):
                (addon / 'package.json').write_text(json.dumps({'name': MODULE.ABI_CONFIG[abi]['addon']}))
                MODULE.install_system_addon(root / abi, addon, abi)
                other = 'x86_64' if abi == 'arm64' else 'arm64'
                with self.assertRaisesRegex(ValueError, 'identity does not match'):
                    MODULE.install_system_addon(root / 'wrong', addon, other)

    def test_system_addon_package_name_is_pinned(self):
        self.assertEqual(MODULE.ABI_CONFIG['arm64']['addon'], '@deepseek-ai/node-addon-system-linux-arm64')

    def test_addon_replaces_pnpm_siblings_and_preserves_links_for_both_abis(self):
        for abi in ('arm64', 'x86_64'):
            with self.subTest(abi=abi), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                tree, addon = root / 'tree', root / 'addon'
                name = MODULE.ABI_CONFIG[abi]['addon']
                sibling = tree / '@deepseek-ai/dsh/node_modules/.pnpm/platform/node_modules' / name
                sibling.mkdir(parents=True)
                (sibling / 'package.json').write_text(json.dumps({'name': name}))
                (sibling / 'obsolete').write_text('must disappear')
                top = tree / '@deepseek-ai/dsh/node_modules' / name
                top.parent.mkdir(parents=True, exist_ok=True)
                top.symlink_to(Path('../.pnpm/platform/node_modules') / name)
                (addon / 'bin/glibc').mkdir(parents=True)
                (addon / 'package.json').write_text(json.dumps({'name': name}))
                (addon / 'bin/glibc/system.node').write_bytes(b'compiled-for-' + abi.encode())
                receipt = MODULE.install_system_addon(tree, addon, abi)
                self.assertTrue(top.is_symlink())
                self.assertEqual((top / 'bin/glibc/system.node').read_bytes(), b'compiled-for-' + abi.encode())
                self.assertFalse((sibling / 'obsolete').exists())
                self.assertEqual(len(receipt['installedPaths']), 1)

    def test_addon_rejects_symlink_outside_engine(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            addon, tree, external = root / 'addon', root / 'tree', root / 'external'
            (addon / 'bin/glibc').mkdir(parents=True)
            name = MODULE.ABI_CONFIG['arm64']['addon']
            (addon / 'package.json').write_text(json.dumps({'name': name}))
            (addon / 'bin/glibc/system.node').write_bytes(b'compiled')
            external.mkdir()
            top = tree / '@deepseek-ai/dsh/node_modules' / name
            top.parent.mkdir(parents=True)
            top.symlink_to(external)
            with self.assertRaisesRegex(ValueError, 'escapes engine'):
                MODULE.install_system_addon(tree, addon)
            self.assertEqual(list(external.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
