import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('collect-linux-licenses.py')
spec = importlib.util.spec_from_file_location('collect_linux_licenses', SCRIPT)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectLinuxLicensesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.packages = {}
        for name, version, files in [
            ('app', '1.0.0', {'LICENSE': 'app notice'}),
            ('runtime', '2.0.0', {'LICENSES/MIT.txt': 'runtime notice'}),
            ('test-only', '1.0.0', {}),
            ('r-efi', '6.0.0', {}),
        ]:
            crate = self.root / f'{name}-{version}'
            crate.mkdir()
            for relative, body in files.items():
                path = crate / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(body, encoding='utf-8')
            package_id = f'registry+https://github.com/rust-lang/crates.io-index#{name}@{version}'
            self.packages[package_id] = {
                'id': package_id, 'name': name, 'version': version,
                'manifest_path': str(crate / 'Cargo.toml'), 'license': 'MIT',
            }
            (crate / 'Cargo.toml').write_text('[package]\nname = "' + name + '"\n', encoding='utf-8')
        self.app_id = next(key for key, value in self.packages.items() if value['name'] == 'app')
        self.runtime_id = next(key for key, value in self.packages.items() if value['name'] == 'runtime')
        self.test_id = next(key for key, value in self.packages.items() if value['name'] == 'test-only')
        self.efi_id = next(key for key, value in self.packages.items() if value['name'] == 'r-efi')

    def metadata(self, include_runtime=True, include_unlicensed_normal=False):
        # cargo metadata --filter-platform has already removed the UEFI-only edge.
        # Both unrelated packages remain in metadata.packages to catch full scans.
        deps = [{'pkg': self.test_id, 'dep_kinds': [{'kind': 'dev', 'target': None}]}]
        if include_runtime:
            deps.append({'pkg': self.runtime_id, 'dep_kinds': [{'kind': 'normal', 'target': None}]})
        if include_unlicensed_normal:
            deps.append({'pkg': self.test_id, 'dep_kinds': [{'kind': 'normal', 'target': None}]})
        return {
            'packages': list(self.packages.values()),
            'resolve': {
                'root': self.app_id,
                'nodes': [
                    {'id': self.app_id, 'deps': deps},
                    {'id': self.runtime_id, 'deps': []},
                    {'id': self.test_id, 'deps': []},
                    {'id': self.efi_id, 'deps': []},
                ],
            },
        }

    def test_target_closure_copies_nested_notices_and_ignores_dev_and_other_target_crates(self):
        output = self.root / 'licenses'
        inventory = collector.collect(self.metadata(), output)
        self.assertEqual([row['name'] for row in inventory], ['app', 'runtime'])
        self.assertEqual((output / 'runtime-2.0.0/LICENSES/MIT.txt').read_text(), 'runtime notice')
        self.assertFalse((output / 'r-efi-6.0.0').exists())

    def test_missing_license_on_reachable_normal_dependency_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'missing native dependency license: test-only'):
            collector.collect(self.metadata(include_unlicensed_normal=True), self.root / 'licenses')

    def test_missing_license_on_required_target_dependency_fails_closed(self):
        self.packages[self.runtime_id]['license'] = None
        (self.root / 'runtime-2.0.0/LICENSES/MIT.txt').unlink()
        with self.assertRaisesRegex(ValueError, 'missing native dependency license: runtime'):
            collector.collect(self.metadata(), self.root / 'licenses')


if __name__ == '__main__':
    unittest.main()
