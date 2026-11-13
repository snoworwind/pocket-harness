"""Regression wrapper for the guest addon cross-build tool.

The tool ships its own `--self-test` (synthetic ELF fixtures plus refusal paths). This
wrapper keeps that coverage inside the repository's `unittest discover` run so a broken
validator cannot land unnoticed.
"""
import importlib.util
import tempfile
import unittest
import json
from unittest.mock import patch
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

    def test_build_emits_the_target_package_identity_for_both_abis(self):
        for abi, platform, machine in [('arm64', 'linux-arm64', 183), ('x86_64', 'linux-x64', 62)]:
            with self.subTest(abi=abi), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / MODULE.ADDON_SOURCE
                source.parent.mkdir(parents=True)
                source.write_text('/* pinned source fixture */')
                package = root / 'native/system/packages' / platform / 'package.json'
                package.parent.mkdir(parents=True)
                name = '@deepseek-ai/node-addon-system-' + platform
                package.write_text(json.dumps({'name': name, 'version': '1.0.0'}))
                def compile_fixture(cc, source, headers, output, target):
                    self.assertEqual(target, abi)
                    output.write_bytes(MODULE.synthetic_elf(machine))
                    return ['fixture-compiler']
                with patch.object(MODULE, 'compiler_identity', return_value={'path': 'fixture'}), \
                     patch.object(MODULE, 'read_headers', return_value={}), \
                     patch.object(MODULE, 'compile_addon', side_effect=compile_fixture):
                    receipt = MODULE.build(root, root, 'fixture', root / 'out', abi)
                    self.assertEqual(receipt['package']['name'], name)
                    self.assertEqual(json.loads((root / 'out/package.json').read_text())['name'], name)
                    package.write_text(json.dumps({'name': 'wrong-platform-package'}))
                    with self.assertRaisesRegex(ValueError, 'identity mismatch'):
                        MODULE.build(root, root, 'fixture', root / 'wrong', abi)

    def test_loader_dependency_matches_target_abi(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'system.node'
            target.write_bytes(b'fixture')
            for abi, machine, loader, foreign in [
                ('arm64', 183, 'ld-linux-aarch64.so.1', 'ld-linux-x86-64.so.2'),
                ('x86_64', 62, 'ld-linux-x86-64.so.2', 'ld-linux-aarch64.so.1'),
            ]:
                facts = dict(type=3, machine=machine, bits=64, architecture=abi, needed=[loader])
                with patch.object(MODULE.native, 'elf_metadata', return_value=facts):
                    MODULE.verify_addon(target, abi)
                    facts['needed'] = [foreign]
                    with self.assertRaisesRegex(ValueError, 'unexpected libraries'):
                        MODULE.verify_addon(target, abi)

    def test_unknown_compiler_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'cross compiler not found'):
            MODULE.compiler_identity('definitely-not-a-cross-compiler')


if __name__ == '__main__':
    unittest.main()
