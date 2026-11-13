import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixtures = load('legacy_asset_fixtures', 'test_package_linux_assets.py')
product = load('linux_product_assets', 'package-linux-product-assets.py')

ABI_CASES = (
    ('arm64', 'linux-arm64-glibc', 'debian-minimal-aarch64.tar.xz', 'linux-arm64'),
    ('x86_64', 'linux-x64-glibc', 'debian-minimal-amd64.tar.xz', 'linux-x64'),
)


def node_archive(fixture, platform):
    return fixture.work / 'input' / f'node-v{fixture.inputs["node"]}-{platform}.tar.xz'


class LinuxProductAssetsTest(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PackageLinuxAssetsTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_packaging_defaults_to_arm64(self):
        self.assertEqual(product.linux_abi()['abi'], 'arm64')
        self.assertEqual(product.linux_abi()['rootfs_asset'], 'debian-minimal-aarch64.tar.xz')

    def test_same_size_poisoned_node_still_fails_closed(self):
        f = self.fixture
        for abi, _, _, platform in ABI_CASES:
            with self.subTest(abi=abi):
                archive = node_archive(f, platform)
                body = archive.read_bytes()
                archive.write_bytes(b'!' + body[1:])
                try:
                    with patch.object(product, 'ROOT', f.root):
                        with self.assertRaisesRegex(ValueError, 'Node archive digest mismatch'):
                            product.package_assets(f.work, 1, abi)
                finally:
                    archive.write_bytes(body)

    def test_missing_abi_node_digest_fails_closed(self):
        f = self.fixture
        inputs = dict(f.inputs)
        inputs.pop('nodeSha256X64')
        (f.root / 'scripts/source-build/linux-inputs.json').write_text(json.dumps(inputs))
        with patch.object(product, 'ROOT', f.root):
            with self.assertRaisesRegex(ValueError, 'missing the pinned Node digest for x86_64'):
                product.package_assets(f.work, 1, 'x86_64')

    def test_product_manifest_selects_assets_per_abi(self):
        # GNU tar is only needed for byte-reproducible archives; this covers ABI selection
        # and manifest naming on hosts that ship BSD tar.
        f = self.fixture
        shutil.rmtree(f.root / 'plugins')
        shutil.rmtree(f.root / 'vendor')

        def fake_tar(command, **kwargs):
            target = Path(command[command.index('-cJf') + 1])
            with tarfile.open(target, 'w:xz') as archive:
                body = b'fixture archive\n'
                item = tarfile.TarInfo('fixture')
                item.size = len(body)
                archive.addfile(item, io.BytesIO(body))
            return subprocess.CompletedProcess(command, 0)

        for abi, runtime, rootfs, platform in ABI_CASES:
            with self.subTest(abi=abi):
                with patch.object(product, 'ROOT', f.root), patch.object(product.subprocess, 'run', side_effect=fake_tar):
                    result = product.package_assets(f.work, 1, abi)
                self.assertEqual(result['runtime'], runtime)
                self.assertEqual(set(result['assets']), {rootfs, f'node-glibc-v{f.inputs["node"]}-{platform}.tar.xz'})
        with patch.object(product, 'ROOT', f.root), patch.object(product.subprocess, 'run', side_effect=fake_tar):
            self.assertEqual(product.package_assets(f.work, 1)['runtime'], 'linux-arm64-glibc')

    def test_product_manifest_contains_only_node_and_rootfs(self):
        tar = subprocess.run(['tar', '--version'], capture_output=True, text=True)
        if tar.returncode or 'GNU tar' not in tar.stdout:
            self.skipTest('deterministic archive unit fixture requires GNU tar; Linux CI runs it')
        f = self.fixture
        # Retired plugin source trees are intentionally absent; product packing must not read them.
        shutil.rmtree(f.root / 'plugins')
        shutil.rmtree(f.root / 'vendor')
        for abi, runtime, rootfs, platform in ABI_CASES:
            with self.subTest(abi=abi):
                with patch.object(product, 'ROOT', f.root):
                    result = product.package_assets(f.work, 1, abi)
                self.assertEqual(result['runtime'], runtime)
                self.assertEqual(set(result['assets']), {rootfs, f'node-glibc-v{f.inputs["node"]}-{platform}.tar.xz'})
                self.assertFalse((f.work / 'assets/linux-bootstrap-plugin.tar.xz').exists())
                self.assertFalse((f.work / 'assets/linux-release.json').exists())
