import importlib.util
import json
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
        paths = workflow.split('      - name: Upload intermediate APK and provenance\n', 1)[1].split('          path: |\n', 1)[1].split('          if-no-files-found:', 1)[0]
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
        self.assertTrue((self.root / 'arm64/.deploy-tmp/linux-build/provenance/linux-assets.json').is_file())
        self.assertFalse((self.root / 'x86_64/.deploy-tmp/linux-build/provenance/linux-assets.json').exists())
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

    def test_experimental_publish_workflow_is_disabled(self):
        workflow = (SCRIPT.parents[2] / '.github/workflows/release-source-draft.yml').read_text(encoding='utf-8')
        script = workflow.split('        run: |\n')[-1]
        script = '\n'.join(line[10:] if line.startswith('          ') else line for line in script.splitlines())
        result = subprocess.run(['/bin/bash', '-c', script], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('gh release', workflow)
        self.assertNotIn('contents: write', workflow)
