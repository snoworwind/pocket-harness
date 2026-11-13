import importlib.util
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixtures = load('legacy_asset_fixtures', 'test_package_linux_assets.py')
product = load('linux_product_assets', 'package-linux-product-assets.py')


class LinuxProductAssetsTest(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PackageLinuxAssetsTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_same_size_poisoned_node_still_fails_closed(self):
        f = self.fixture
        archive = f.work / 'input' / f'node-v{f.inputs["node"]}-linux-arm64.tar.xz'
        body = archive.read_bytes()
        archive.write_bytes(b'!' + body[1:])
        with patch.object(product, 'ROOT', f.root):
            with self.assertRaisesRegex(ValueError, 'Node archive digest mismatch'):
                product.package_assets(f.work, 1)

    def test_product_manifest_contains_only_node_and_rootfs(self):
        tar = subprocess.run(['tar', '--version'], capture_output=True, text=True)
        if tar.returncode or 'GNU tar' not in tar.stdout:
            self.skipTest('deterministic archive unit fixture requires GNU tar; Linux CI runs it')
        f = self.fixture
        # Retired plugin source trees are intentionally absent; product packing must not read them.
        shutil.rmtree(f.root / 'plugins')
        shutil.rmtree(f.root / 'vendor')
        with patch.object(product, 'ROOT', f.root):
            result = product.package_assets(f.work, 1)
        self.assertEqual(result['runtime'], 'linux-arm64-glibc')
        self.assertEqual(set(result['assets']), {'debian-minimal-aarch64.tar.xz', f'node-glibc-v{f.inputs["node"]}-linux-arm64.tar.xz'})
        self.assertFalse((f.work / 'assets/linux-bootstrap-plugin.tar.xz').exists())
        self.assertFalse((f.work / 'assets/linux-release.json').exists())
