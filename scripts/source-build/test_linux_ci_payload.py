import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


home_check = load('linux_home', 'check-linux-home.py')
comparison = load('linux_compare', 'compare-linux-apks.py')
injection = load('linux_inject', 'inject-linux-home.py')
notices = load('linux_notices', 'write-linux-notices.py')
guest = load('linux_guest', 'check-linux-guest.py')


class LinuxCiPayloadTest(unittest.TestCase):
    def test_plugin_injection_guest_paths_and_home_privacy_controls(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repository = root / 'repo'
            (repository / 'scripts').mkdir(parents=True)
            (repository / 'scripts/plugin-dirs.json').write_text(json.dumps(dict(dirs=[], externals=[])))
            (repository / 'scripts/profile-web.cordis.patch.yml').write_text('''bashPath: /data/data/com.snoworwind.pocketharness/files/usr/bin/bash
prefix: /data/data/com.snoworwind.pocketharness/files/usr
home: /data/data/com.snoworwind.pocketharness/files/home
cwd: /data/data/com.snoworwind.pocketharness/files/home
executable: /data/data/com.snoworwind.pocketharness/files/usr/libexec/dsh-node
''')
            for name in ('web', 'headless'):
                profile = root / 'home/.dsh/profiles' / name
                profile.mkdir(parents=True)
                (profile / 'package.json').write_text(json.dumps(dict(dsh=dict(profile=dict(bundles=['base', name])))))
            settings = root / 'home/.dsh/settings.yaml'
            settings.write_text('llm-deepseek: {}\n')
            with patch.object(injection.payload, 'build_ext_replacements', return_value={'fixture': {'package.json': b'{}', 'lib/index.js': b'export {}'}}):
                self.assertEqual(injection.inject(root, repository), ['fixture'])
            for name in ('web', 'headless'):
                profile = root / 'home/.dsh/profiles' / name
                self.assertTrue((profile / 'node_modules/fixture/lib/index.js').is_file())
                self.assertIn('executable: /opt/node/bin/node', (profile / 'cordis.patch.yml').read_text())
            self.assertTrue(home_check.check(root / 'home'))
            settings.write_text('apiKey: private\n')
            with self.assertRaisesRegex(ValueError, 'secret'):
                home_check.check(root / 'home')
            settings.write_text('llm-deepseek: {}\n')
            (root / 'home/.dsh/.credentials').write_text('private')
            with self.assertRaisesRegex(ValueError, 'private runtime data'):
                home_check.check(root / 'home')

    def test_independent_comparison_ignores_signatures_but_not_other_entries(self):
        with tempfile.TemporaryDirectory() as temporary:
            left, right = [Path(temporary) / name for name in ('a.apk', 'b.apk')]
            def make(path, signature, payload='same', service='same'):
                with zipfile.ZipFile(path, 'w') as archive:
                    archive.writestr('classes.dex', payload)
                    archive.writestr('META-INF/CERT.RSA', signature)
                    archive.writestr('META-INF/services/test', service)
            make(left, 'left')
            make(right, 'right')
            # Payload verifier has its own real ZIP controls; isolate comparison's signature boundary.
            with patch.object(comparison.payload, 'verify', return_value={}):
                self.assertTrue(comparison.compare(left, right)['independentRebuildMatched'])
                self.assertEqual(comparison.compare(left, right, 'x86_64')['runtime'], 'linux-x64-glibc')
                with self.assertRaisesRegex(ValueError, 'different APK'):
                    comparison.compare(left, left)
                for payload, service in [('changed', 'same'), ('same', 'changed')]:
                    make(right, 'right', payload, service)
                    with self.assertRaisesRegex(ValueError, 'payload differs'):
                        comparison.compare(left, right)

    def test_notices_bind_real_debian_and_harness_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def put(name, body):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(body)
            put('.deploy-tmp/linux-build/provenance/debian-packages.tsv', 'libc6\t2.41\tglibc\t2.41\n')
            put('scripts/source-build/linux-inputs.json', json.dumps(dict(node='24.22.0', pnpm=dict(version='11.28.5'))))
            put('.deploy-tmp/engine-overlay/source-build-manifest.json', json.dumps(dict(commit='a'*40, packages=[dict(name='fixture', version='1')])) )
            notices.generate(root, root / 'notices.md')
            self.assertIn('| libc6 | 2.41 | glibc | 2.41 |', (root / 'notices.md').read_text())
            self.assertIn('| fixture | 1 |', (root / 'notices.md').read_text())
            put('.deploy-tmp/linux-build/provenance/debian-packages.tsv', '')
            with self.assertRaisesRegex(ValueError, 'complete Debian'):
                notices.generate(root, root / 'notices.md')

    def test_guest_native_abi_rejects_host_or_truncated_bindings(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'binding.node'
            header = bytearray(20)
            header[:6] = b'\x7fELF\x02\x01'
            header[18:20] = (183).to_bytes(2, 'little')
            path.write_bytes(header)
            guest.guest_elf(path, 'arm64')
            header[18:20] = (62).to_bytes(2, 'little')
            path.write_bytes(header)
            with self.assertRaisesRegex(ValueError, 'AArch64'):
                guest.guest_elf(path, 'arm64')
            path.write_bytes(b'bad')
            with self.assertRaisesRegex(ValueError, 'AArch64'):
                guest.guest_elf(path, 'arm64')
