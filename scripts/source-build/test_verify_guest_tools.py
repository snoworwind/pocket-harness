"""Regression wrapper for the guest tool probe."""
import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    'verify_guest_tools', Path(__file__).with_name('verify-guest-tools.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class VerifyGuestToolsTest(unittest.TestCase):
    def test_self_test_passes(self):
        self.assertEqual(MODULE.self_test(), 0)

    def test_manifest_declares_every_probe_package(self):
        manifest = MODULE.load_manifest()
        declared = set(manifest['packages'])
        for entry in manifest['commands']:
            self.assertIn(entry['package'], declared, entry['command'])

    def test_manifest_covers_the_core_development_tools(self):
        commands = {entry['command'] for entry in MODULE.load_manifest()['commands']}
        for required in ('bash', 'git', 'python3', 'gcc', 'make', 'rg', 'jq', 'sqlite3', 'curl', 'ssh', 'rsync', 'tmux', 'vim'):
            self.assertIn(required, commands)


if __name__ == '__main__':
    unittest.main()
