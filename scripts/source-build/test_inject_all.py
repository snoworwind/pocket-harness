import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('inject_all', ROOT / 'scripts' / 'inject-all.py')
inject_all = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inject_all)


class InjectAllPackageIdentityTest(unittest.TestCase):
    def make_package(self, root: Path, directory: str, package_name: str) -> Path:
        package = root / directory
        (package / 'lib').mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'name': package_name}), encoding='utf-8')
        (package / 'lib' / 'index.js').write_text('export const ok = true\n', encoding='utf-8')
        return package

    def test_directory_name_must_not_override_package_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bootstrap = self.make_package(root, 'dsh-linux-bootstrap', '@dsh-android/linux-bootstrap')
            bridge = self.make_package(root, 'dsh-android-bridge', '@dsh-android/dsh-android-bridge')
            replacements = inject_all.build_dsh_replacements([str(bootstrap), str(bridge)])
            self.assertEqual({'linux-bootstrap', 'dsh-android-bridge'}, set(replacements))
            self.assertNotIn('dsh-linux-bootstrap', replacements)
            self.assertIn('package.json', replacements['linux-bootstrap'])
            self.assertIn('lib/index.js', replacements['linux-bootstrap'])

    def test_non_namespace_package_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bad = self.make_package(root, 'bad-plugin', '@other/bad-plugin')
            with self.assertRaises(SystemExit):
                inject_all.build_dsh_replacements([str(bad)])

    def test_nested_package_name_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bad = self.make_package(root, 'bad-plugin', '@dsh-android/team/bad-plugin')
            with self.assertRaises(SystemExit):
                inject_all.build_dsh_replacements([str(bad)])


if __name__ == '__main__':
    unittest.main()
