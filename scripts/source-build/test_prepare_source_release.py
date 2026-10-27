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
        workflow = (SCRIPT.parents[2] / '.github/workflows/build-apk-source.yml').read_text()
        paths = workflow.split('      - name: Upload APK and provenance\n', 1)[1].split('          path: |\n', 1)[1].split('          if-no-files-found:', 1)[0]
        for line in paths.splitlines():
            path = line.strip()
            if '*' not in path:
                self.put(path, '{}')
        self.put('scripts/patches/tests/fixtures/test-0.2.1-rc.3/probe.js', 'fixture')
        self.put('.deploy-tmp/linux-build/provenance/linux-assets.json', '{}')
        self.apk = 'out/v1-source/pocket-harness-v1-source-arm64.apk'
        self.put(self.apk, 'original APK bytes')
        self.base = '.deploy-tmp/source-build/'
        self.put(self.base + 'project-source-commit.txt', self.env['GITHUB_SHA'])
        self.put(self.base + 'project-component-provenance.json', json.dumps(dict(
            projectCommit=self.env['GITHUB_SHA'], sourceRepository='https://github.com/fixture/fork')))
        self.put(self.base + 'component-source-provenance.json', json.dumps(dict(projectCommit=self.env['GITHUB_SHA'])))
        self.put(self.base + 'apk-sha256.txt', self.apk + '\n' + module.digest(self.root / self.apk) + '  ' + self.apk + '\n')
        self.put(self.base + 'independent-rebuild-verification.json', json.dumps(dict(
            independentRebuildMatched=True, normalizationVersion=3, sourceCommit=self.env['GITHUB_SHA'],
            signedApkSha256=module.digest(self.root / self.apk))))

    def put(self, path, text):
        path = self.root / path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')

    def run_prepare(self):
        module.prepare(self.root, self.output, self.env)

    def test_unchanged_apk_and_hidden_evidence(self):
        self.run_prepare()
        self.assertEqual((self.root / self.apk).read_bytes(), (self.output / Path(self.apk).name).read_bytes())
        with zipfile.ZipFile(self.output / 'provenance.zip') as archive:
            self.assertIn(self.base + 'project-component-provenance.json', archive.namelist())
        for line in (self.output / 'SHA256SUMS.txt').read_text().splitlines():
            sha, name = line.split('  ')
            self.assertEqual(module.digest(self.output / name), sha)

    def test_negative_controls(self):
        for path, replacement in [
            (self.apk, 'tampered APK'),
            (self.base + 'project-source-commit.txt', 'b' * 40),
            (self.base + 'project-component-provenance.json', json.dumps(dict(projectCommit='a' * 40, sourceRepository='https://github.com/other/repo'))),
        ]:
            with self.subTest(path=path):
                original = (self.root / path).read_text()
                self.put(path, replacement)
                with self.assertRaises(ValueError):
                    self.run_prepare()
                self.assertFalse(self.output.exists())
                self.put(path, original)

    def test_missing_evidence_blocks_preparation(self):
        (self.root / self.base / 'snapshot-normalization.json').unlink()
        with self.assertRaisesRegex(ValueError, 'missing evidence'):
            self.run_prepare()

    def test_wrong_or_stale_independent_proof_blocks_preparation(self):
        path = self.base + 'independent-rebuild-verification.json'
        original = json.loads((self.root / path).read_text())
        for field, value in [('independentRebuildMatched', False), ('normalizationVersion', 2), ('sourceCommit', 'b' * 40), ('signedApkSha256', '0' * 64)]:
            self.put(path, json.dumps({**original, field: value}))
            with self.assertRaisesRegex(ValueError, 'independent rebuild proof'):
                self.run_prepare()
            self.assertFalse(self.output.exists())
        self.put(path, json.dumps(original))

    def test_wrong_branch_blocks_preparation(self):
        self.env['GITHUB_REF'] = 'refs/heads/feature/not-main'
        with self.assertRaisesRegex(ValueError, 'invalid source branch'):
            self.run_prepare()

    @unittest.skipUnless(sys.platform == 'linux', 'actual workflow shell requires Linux')
    def test_actual_publish_shell_is_draft_only_and_rejects_changed_assets(self):
        self.run_prepare()
        workflow = (SCRIPT.parents[2] / '.github/workflows/release-source-draft.yml').read_text()
        script = workflow.split('        run: |\n')[-1]
        script = '\n'.join(line[10:] if line.startswith('          ') else line for line in script.splitlines())
        # Run the production shell with only the network CLI replaced by a recorder.
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
        calls.unlink()
        assets = work / 'release-assets'
        # An unlisted APK must never reach the privileged gh invocation.
        extra = assets / 'injected.apk'
        extra.write_text('unverified APK')
        result = subprocess.run(['/bin/bash', '-c', script], cwd=work, env=env, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(calls.exists())
        extra.unlink()
        sums = assets / 'SHA256SUMS.txt'
        original_sums = sums.read_text()
        for replacement in [
            '\n'.join(original_sums.splitlines()[1:]) + '\n',
            original_sums + original_sums.splitlines()[0] + '\n',
            original_sums.replace('  notes.md', '  ../notes.md'),
        ]:
            with self.subTest(manifest=replacement):
                sums.write_text(replacement)
                result = subprocess.run(['/bin/bash', '-c', script], cwd=work, env=env, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(calls.exists())
        sums.write_text(original_sums)
        (work / 'release-assets' / Path(self.apk).name).write_text('changed')
        result = subprocess.run(['/bin/bash', '-c', script], cwd=work, env=env, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(calls.exists())


if __name__ == '__main__':
    unittest.main()
