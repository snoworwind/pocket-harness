import importlib.util
import json
import hashlib
from pathlib import Path
import tempfile
import unittest
import zipfile
import os
import subprocess
import sys

SCRIPT = Path(__file__).with_name('prepare-source-release.py')
spec = importlib.util.spec_from_file_location('prepare_release', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleasePreparationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'input'
        self.output = Path(self.temp.name) / 'output'
        self.env = dict(GITHUB_SHA='a' * 40, GITHUB_REPOSITORY='fixture/fork',
                        GITHUB_REF='refs/heads/main', GITHUB_RUN_ID='123')
        workflow = (SCRIPT.parents[2] / '.github/workflows/build-apk-source.yml').read_text(encoding='utf-8')
        paths = workflow.split('      - name: Upload APK and provenance\n', 1)[1].split('          path: |\n', 1)[1].split('          if-no-files-found:', 1)[0]
        for abi in module.ABIS:
            for line in paths.splitlines():
                path = line.strip()
                arm64_only_evidence = {
                    '.deploy-tmp/source-build/linux-bundle-injection.json',
                    '.deploy-tmp/linux-build/provenance/**',
                }
                if '*' not in path and not (abi == 'x86_64' and path in arm64_only_evidence):
                    self.put(abi, path, '{}')
            self.put(abi, 'scripts/patches/tests/fixtures/test-0.2.2-rc.1/probe.js', 'fixture')
            if abi == 'arm64':
                self.put(abi, '.deploy-tmp/linux-build/provenance/linux-assets.json', '{}')
                names = ['linux-bootstrap-plugin.tar.xz', 'linux-runtime-plugin.tar.xz', 'proot-backend-aarch64.tar.xz', 'debian-minimal-aarch64.tar.xz', 'node-glibc-v24.22.0-linux-arm64.tar.xz']
                descriptors = []
                for name in names:
                    body = 'verified archive fixture'
                    self.put(abi, '.deploy-tmp/linux-build/assets/' + name, body)
                    descriptors.append(dict(url='https://github.com/fixture/fork/releases/download/v1/' + name, size=len(body), sha256=hashlib.sha256(body.encode()).hexdigest()))
                manifest = dict(plugins=dict(bootstrap=descriptors[0], runtime=descriptors[1]), runtimes=[dict(backendAsset=descriptors[2], rootfsAsset=descriptors[3], nodeAsset=descriptors[4])])
                body = json.dumps(manifest)
                self.put(abi, '.deploy-tmp/linux-build/assets/linux-release.json', body)
                self.put(abi, '.deploy-tmp/linux-build/assets/linux-runtime-manifest.sha256', hashlib.sha256(body.encode()).hexdigest())
        self.apks = {}
        self.base = '.deploy-tmp/source-build/'
        for abi in module.ABIS:
            apk = f'out/v1-source/pocket-harness-v1-source-{abi}.apk'
            self.apks[abi] = apk
            self.put(abi, apk, f'original {abi} APK bytes')
            self.put(abi, self.base + 'project-source-commit.txt', self.env['GITHUB_SHA'])
            self.put(abi, self.base + 'project-component-provenance.json', json.dumps(dict(
                projectCommit=self.env['GITHUB_SHA'], sourceRepository='https://github.com/fixture/fork')))
            self.put(abi, self.base + 'component-source-provenance.json', json.dumps(dict(projectCommit=self.env['GITHUB_SHA'])))
            self.put(abi, self.base + 'apk-sha256.txt', apk + '\n' + module.digest(self.root / abi / apk) + '  ' + apk + '\n')
            self.put(abi, self.base + 'independent-rebuild-verification.json', json.dumps(dict(
                abi=abi, independentRebuildMatched=True, normalizationVersion=3, sourceCommit=self.env['GITHUB_SHA'],
                signedApkSha256=module.digest(self.root / abi / apk))))

    def put(self, abi, path, text):
        target = self.root / abi / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8')

    def run_prepare(self):
        module.prepare(self.root, self.output, self.env)

    def test_unchanged_apks_and_hidden_evidence_for_both_abis(self):
        self.run_prepare()
        self.assertEqual((self.output / 'linux-runtime-plugin.tar.xz').read_text(), 'verified archive fixture')
        self.assertTrue((self.root / 'arm64/.deploy-tmp/source-build/linux-bundle-injection.json').is_file())
        self.assertFalse((self.root / 'x86_64/.deploy-tmp/source-build/linux-bundle-injection.json').exists())
        self.assertFalse((self.root / 'x86_64/.deploy-tmp/linux-build/provenance').exists())
        for abi, apk in self.apks.items():
            self.assertEqual((self.root / abi / apk).read_bytes(), (self.output / Path(apk).name).read_bytes())
        with zipfile.ZipFile(self.output / 'provenance.zip') as archive:
            names = archive.namelist()
            self.assertIn('arm64/' + self.base + 'project-component-provenance.json', names)
            self.assertIn('x86_64/' + self.base + 'project-component-provenance.json', names)
        for line in (self.output / 'SHA256SUMS.txt').read_text().splitlines():
            sha, name = line.split('  ')
            self.assertEqual(module.digest(self.output / name), sha)
        notes = (self.output / 'notes.md').read_text()
        self.assertIn('ARM64 and x86_64', notes)
        self.assertIn('omits offline PRoot Linux assets', notes)

    def test_negative_controls(self):
        cases = [
            ('arm64', self.apks['arm64'], 'tampered APK'),
            ('x86_64', self.apks['x86_64'], 'tampered APK'),
            ('arm64', self.base + 'project-source-commit.txt', 'b' * 40),
            ('x86_64', self.base + 'project-component-provenance.json', json.dumps(dict(
                projectCommit='a' * 40, sourceRepository='https://github.com/other/repo'))),
        ]
        for abi, path, replacement in cases:
            with self.subTest(abi=abi, path=path):
                target = self.root / abi / path
                original = target.read_text()
                self.put(abi, path, replacement)
                with self.assertRaises(ValueError):
                    self.run_prepare()
                self.assertFalse(self.output.exists())
                self.put(abi, path, original)

    def test_missing_abi_blocks_preparation(self):
        import shutil
        shutil.rmtree(self.root / 'x86_64')
        with self.assertRaisesRegex(ValueError, 'only real arm64 and x86_64 directories'):
            self.run_prepare()

    def test_unexpected_source_root_entry_blocks_preparation(self):
        (self.root / 'extra').mkdir()
        with self.assertRaisesRegex(ValueError, 'only real arm64 and x86_64 directories'):
            self.run_prepare()

    @unittest.skipUnless(sys.platform == 'linux', 'artifact symlink checks require Linux')
    def test_source_root_abi_symlink_blocks_preparation(self):
        import shutil
        shutil.rmtree(self.root / 'x86_64')
        os.symlink(self.root / 'arm64', self.root / 'x86_64', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'only real arm64 and x86_64 directories'):
            self.run_prepare()

    def test_different_apk_versions_block_preparation(self):
        import re
        x86 = self.root / 'x86_64' / self.apks['x86_64']
        newer = x86.with_name('pocket-harness-v2-source-x86_64.apk')
        newer.write_bytes(x86.read_bytes())
        x86.unlink()
        self.apks['x86_64'] = str(newer.relative_to(self.root / 'x86_64')).replace('\\', '/')
        self.put('x86_64', self.base + 'apk-sha256.txt', self.apks['x86_64'] + '\n' + module.digest(newer) + '  ' + self.apks['x86_64'] + '\n')
        proof_path = self.root / 'x86_64' / self.base / 'independent-rebuild-verification.json'
        proof = json.loads(proof_path.read_text())
        proof['signedApkSha256'] = module.digest(newer)
        proof_path.write_text(json.dumps(proof))
        self.assertIsNotNone(re.fullmatch(r'pocket-harness-v[\w.+-]+-source-x86_64\.apk', newer.name))
        with self.assertRaisesRegex(ValueError, 'APK version names do not match'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_copied_wrong_abi_proof_blocks_preparation(self):
        import shutil
        shutil.rmtree(self.root / 'x86_64')
        shutil.copytree(self.root / 'arm64', self.root / 'x86_64')
        copied_apk = self.root / 'x86_64' / self.apks['arm64']
        renamed = self.root / 'x86_64' / 'out/v2-source/pocket-harness-v2-source-x86_64.apk'
        renamed.parent.mkdir(parents=True)
        renamed.write_bytes(copied_apk.read_bytes())
        copied_apk.unlink()
        with self.assertRaisesRegex(ValueError, 'APK hash mismatch|proof does not bind'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_missing_evidence_blocks_preparation(self):
        (self.root / 'arm64' / self.base / 'snapshot-normalization.json').unlink()
        with self.assertRaisesRegex(ValueError, 'missing arm64 evidence'):
            self.run_prepare()

    def test_arm64_linux_bundle_evidence_remains_required(self):
        (self.root / 'arm64' / self.base / 'linux-bundle-injection.json').unlink()
        with self.assertRaisesRegex(ValueError, 'missing arm64 evidence: .deploy-tmp/source-build/linux-bundle-injection.json'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_arm64_linux_asset_provenance_remains_required(self):
        import shutil
        shutil.rmtree(self.root / 'arm64/.deploy-tmp/linux-build/provenance')
        with self.assertRaisesRegex(ValueError, 'missing arm64 evidence: .deploy-tmp/linux-build/provenance/\\*\\*'):
            self.run_prepare()
        self.assertFalse(self.output.exists())

    def test_wrong_or_stale_independent_proof_blocks_preparation(self):
        path = self.root / 'x86_64' / self.base / 'independent-rebuild-verification.json'
        original = json.loads(path.read_text())
        for field, value in [('abi', 'arm64'), ('independentRebuildMatched', False), ('normalizationVersion', 2),
                             ('sourceCommit', 'b' * 40), ('signedApkSha256', '0' * 64)]:
            path.write_text(json.dumps({**original, field: value}))
            with self.assertRaisesRegex(ValueError, 'x86_64 independent rebuild proof'):
                self.run_prepare()
            self.assertFalse(self.output.exists())
        path.write_text(json.dumps(original))

    def test_wrong_branch_blocks_preparation(self):
        self.env['GITHUB_REF'] = 'refs/heads/feature/not-main'
        with self.assertRaisesRegex(ValueError, 'invalid source branch'):
            self.run_prepare()

    @unittest.skipUnless(sys.platform == 'linux', 'actual workflow shell requires Linux')
    def test_actual_publish_shell_is_draft_only_and_rejects_changed_assets(self):
        self.run_prepare()
        workflow = (SCRIPT.parents[2] / '.github/workflows/release-source-draft.yml').read_text(encoding='utf-8')
        script = workflow.split('        run: |\n')[-1]
        script = '\n'.join(line[10:] if line.startswith('          ') else line for line in script.splitlines())
        work = Path(self.temp.name)
        self.output.rename(work / 'release-assets')
        bin_dir = work / 'bin'
        bin_dir.mkdir()
        recorder = bin_dir / 'gh'
        recorder.write_text(f'#!{sys.executable}\nimport json,sys\nfrom pathlib import Path\nPath("calls.json").write_text(json.dumps(sys.argv[1:]))\n')
        recorder.chmod(0o755)
        env = dict(os.environ, PATH=str(bin_dir) + ':' + os.environ['PATH'],
                   SOURCE_SHA=self.env['GITHUB_SHA'], RUN_ID='123', RUN_ATTEMPT='1')
        result = subprocess.run(['/bin/bash', '-c', script], cwd=work, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = work / 'release-assets/calls.json'
        args = json.loads(calls.read_text())
        self.assertEqual(args[:3], ['release', 'create', 'hardening-source-aaaaaaaaaaaa-123-1'])
        self.assertIn('--draft', args)
        self.assertIn('--prerelease', args)
        self.assertEqual(args[args.index('--target') + 1], self.env['GITHUB_SHA'])
        self.assertTrue(any(name.endswith('-source-arm64.apk') for name in args))
        self.assertTrue(any(name.endswith('-source-x86_64.apk') for name in args))
        calls.unlink()
        assets = work / 'release-assets'
        extra = assets / 'injected.apk'
        extra.write_text('unverified APK')
        result = subprocess.run(['/bin/bash', '-c', script], cwd=work, env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(calls.exists())
        extra.unlink()
        missing_x86 = assets / Path(self.apks['x86_64']).name
        held_x86 = assets / 'held-x86.apk'
        missing_x86.rename(held_x86)
        result = subprocess.run(['/bin/bash', '-c', script], cwd=work, env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(calls.exists())
        held_x86.rename(missing_x86)
        sums = assets / 'SHA256SUMS.txt'
        original_sums = sums.read_text()
        for replacement in [
            '\n'.join(original_sums.splitlines()[1:]) + '\n',
            original_sums + original_sums.splitlines()[0] + '\n',
            original_sums.replace('  notes.md', '  ../notes.md'),
        ]:
            with self.subTest(manifest=replacement):
                sums.write_text(replacement)
                result = subprocess.run(['/bin/bash', '-c', script], cwd=work, env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(calls.exists())
        sums.write_text(original_sums)
        (assets / Path(self.apks['x86_64']).name).write_text('changed')
        result = subprocess.run(['/bin/bash', '-c', script], cwd=work, env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(calls.exists())


if __name__ == '__main__':
    unittest.main()
