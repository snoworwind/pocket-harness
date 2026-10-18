import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('package-linux-assets.py')
spec = importlib.util.spec_from_file_location('package_linux', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PackageLinuxAssetsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / '.deploy-tmp/linux-build'
        (self.work / 'input').mkdir(parents=True)
        (self.work / 'assets').mkdir()
        self.inputs = json.loads(SCRIPT.with_name('linux-inputs.json').read_text())
        node = self.work / 'input' / f'node-v{self.inputs["node"]}-linux-arm64.tar.xz'
        self.archive(node, {f'node-v{self.inputs["node"]}-linux-arm64/{name}': text for name, text in {
            'bin/node': 'fixture Node bytes, not a native runtime', 'lib/node_modules/npm/index.js': 'fixture npm', 'LICENSE': 'fixture license'}.items()})
        with node.open('rb') as stream:
            self.inputs['nodeSha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
        self.put('scripts/source-build/linux-inputs.json', json.dumps(self.inputs))
        for package in ['linux-runtime', 'linux-bootstrap']:
            directory = 'vendor/dsh-linux-runtime' if package == 'linux-runtime' else 'plugins/dsh-linux-bootstrap'
            self.put(directory + '/package.json', json.dumps(dict(name='@dsh-android/' + package, version='0.5.0')))
            if package == 'linux-runtime':
                self.put(directory + '/lib/index.js', 'export const fixture = true')
                self.put(directory + '/modules/manager.js', 'export const fixture = true')
                self.put(directory + '/LICENSE', 'fixture license')
            else:
                self.put(directory + '/src/index.js', 'export const fixture = true')
                self.put(directory + '/client/index.js', 'export const fixture = true')
        self.put('vendor/bionilux/LICENSE', 'fixture license')
        for name in ['bionilux-backend-aarch64.tar.xz', 'debian-minimal-aarch64.tar.xz']:
            self.archive(self.work / 'assets' / name, {'fixture': 'fixture archive, not a native runtime'})

    def put(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def archive(self, file, entries):
        with tarfile.open(file, 'w:xz') as archive:
            for name, body in entries.items():
                data = body.encode()
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))

    def run_package(self):
        with patch.object(module, 'ROOT', self.root), patch.dict(os.environ, {'GITHUB_REPOSITORY': 'fixture/private'}):
            return module.package_assets(self.work, 1)

    def test_local_manifest_binds_all_archives_and_has_no_runtime_download_requirement(self):
        manifest = self.run_package()
        self.assertEqual(manifest['runtimes'][0]['architecture'], 'arm64')
        for asset in [*manifest['plugins'].values(), *[manifest['runtimes'][0][key] for key in ['backendAsset', 'rootfsAsset', 'nodeAsset']]]:
            archive = self.work / 'assets' / asset['url'].rsplit('/', 1)[1]
            with archive.open('rb') as stream:
                self.assertEqual(hashlib.file_digest(stream, 'sha256').hexdigest(), asset['sha256'])
        data = (self.work / 'assets/linux-release.json').read_bytes()
        self.assertEqual((self.work / 'assets/linux-runtime-manifest.sha256').read_text().strip(), hashlib.sha256(data).hexdigest())

    def test_same_size_poisoned_node_archive_is_rejected_before_unpacking(self):
        archive = self.work / 'input' / f'node-v{self.inputs["node"]}-linux-arm64.tar.xz'
        data = archive.read_bytes()
        archive.write_bytes(b'!' + data[1:])
        with self.assertRaisesRegex(ValueError, 'Node archive digest mismatch'):
            self.run_package()

    def test_output_root_cannot_escape_dedicated_workspace(self):
        with patch.object(module, 'ROOT', self.root):
            with self.assertRaisesRegex(ValueError, 'dedicated build directory'):
                module.package_assets(self.root / 'outside', 1)


if __name__ == '__main__':
    unittest.main()
