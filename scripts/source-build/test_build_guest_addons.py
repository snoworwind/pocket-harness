"""Regression wrapper for the guest addon cross-build tool.

The tool ships its own `--self-test` (synthetic ELF fixtures plus refusal paths). This
wrapper keeps that coverage inside the repository's `unittest discover` run so a broken
validator cannot land unnoticed.
"""
import importlib.util
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    'build_guest_addons', Path(__file__).with_name('build-guest-addons.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BuildGuestAddonsTest(unittest.TestCase):
    def test_self_test_passes(self):
        self.assertEqual(MODULE.self_test(), 0)

    def test_arm64_shared_object_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'system.node'
            target.write_bytes(MODULE.synthetic_elf(183))
            facts = MODULE.verify_addon(target, 'arm64')
        self.assertEqual(facts['architecture'], 'arm64')
        self.assertEqual(facts['type'], 3)

    def test_foreign_architecture_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'system.node'
            target.write_bytes(MODULE.synthetic_elf(62))
            with self.assertRaisesRegex(ValueError, 'does not match arm64'):
                MODULE.verify_addon(target, 'arm64')

    def test_unknown_compiler_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'cross compiler not found'):
            MODULE.compiler_identity('definitely-not-a-cross-compiler')


if __name__ == '__main__':
    unittest.main()
