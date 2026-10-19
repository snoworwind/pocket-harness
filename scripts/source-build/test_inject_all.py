import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('inject_all', ROOT / 'scripts' / 'inject-all.py')
inject_all = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inject_all)


class InjectAllPackageIdentityTest(unittest.TestCase):
    def test_new_and_directory_only_packages_have_unique_archive_members(self):
        for directory_only in (False, True):
            with self.subTest(directory_only=directory_only), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                plugin = self.make_package(root, 'probe', '@dsh-android/probe')
                source, output = root / 'source.tar.xz', root / 'output.tar.xz'
                config = root / 'patch.yml'
                config.write_text('plugins: {}\n', encoding='utf-8')
                with tarfile.open(source, 'w:xz') as archive:
                    for profile in inject_all.PROFILES:
                        if directory_only:
                            member = tarfile.TarInfo(f'home/.dsh/profiles/{profile}/node_modules/@dsh-android/probe/lib')
                            member.type = tarfile.DIRTYPE
                            archive.addfile(member)
                    member = tarfile.TarInfo('usr/bin/keep')
                    member.size = 4
                    archive.addfile(member, io.BytesIO(b'keep'))
                argv = ['inject-all.py', str(source), str(output), str(config), '--dsh-android', str(plugin)]
                with patch.object(inject_all.sys, 'argv', argv), patch.dict(inject_all.os.environ, {'DSH_INJECT_PRESET': '0'}):
                    inject_all.main()
                with tarfile.open(output, 'r:xz') as archive:
                    names = archive.getnames()
                    self.assertEqual(len(names), len(set(names)), 'duplicate tar members block independent APK verification')
                    self.assertEqual(archive.extractfile('usr/bin/keep').read(), b'keep')
                    for profile in inject_all.PROFILES:
                        base = f'home/.dsh/profiles/{profile}/node_modules/@dsh-android/probe'
                        self.assertEqual(archive.extractfile(base + '/lib/index.js').read(), (plugin / 'lib/index.js').read_bytes())
                        self.assertIn(base + '/package.json', names)

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

    def add_runtime_dep(self, package: Path, name: str, dependencies=None):
        dep = package / 'node_modules' / name
        dep.mkdir(parents=True)
        (dep / 'package.json').write_text(
            json.dumps({'name': name, 'dependencies': dependencies or {}}), encoding='utf-8')
        (dep / 'index.js').write_text('export const dep = true\n', encoding='utf-8')
        return dep

    def test_runtime_dependency_closure_is_injected_into_the_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plugin = self.make_package(root, 'dsh-android-linux-env', '@dsh-android/dsh-android-linux-env')
            (plugin / 'package.json').write_text(json.dumps({
                'name': '@dsh-android/dsh-android-linux-env',
                'dependencies': {
                    '@dsh-android/dsh-android-bridge': 'file:../dsh-android-bridge',
                    '@deepseek-ai/dsh-tools': '0.2.0-rc.2',
                    'runtime-a': '1.0.0',
                },
            }), encoding='utf-8')
            self.add_runtime_dep(plugin, 'runtime-a', {'runtime-b': '1.0.0'})
            self.add_runtime_dep(plugin, 'runtime-b')

            files = inject_all.build_dsh_replacements([str(plugin)])['dsh-android-linux-env']
            self.assertIn('node_modules/runtime-a/package.json', files)
            self.assertIn('node_modules/runtime-a/index.js', files)
            self.assertIn('node_modules/runtime-b/package.json', files)
            self.assertNotIn('node_modules/@dsh-android/dsh-android-bridge/package.json', files)
            self.assertNotIn('node_modules/@deepseek-ai/dsh-tools/package.json', files)

    def test_missing_runtime_dependency_is_a_build_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plugin = self.make_package(root, 'dsh-android-linux-env', '@dsh-android/dsh-android-linux-env')
            (plugin / 'package.json').write_text(json.dumps({
                'name': '@dsh-android/dsh-android-linux-env',
                'dependencies': {'xz-decompress': '0.2.3'},
            }), encoding='utf-8')
            with self.assertRaises(SystemExit):
                inject_all.build_dsh_replacements([str(plugin)])


if __name__ == '__main__':
    unittest.main()
