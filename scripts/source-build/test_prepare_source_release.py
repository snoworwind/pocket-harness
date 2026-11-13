import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).with_name('prepare-source-release.py')
REPO = SCRIPT.parents[2]
spec = importlib.util.spec_from_file_location('prepare_release', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PINNED = (REPO / 'keystore/pocket-harness-cert-sha256.txt').read_text(encoding='utf-8').strip()


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


class ReleasePreparationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'input'
        self.output = Path(self.temp.name) / 'output'
        self.env = dict(GITHUB_SHA='a' * 40, GITHUB_REPOSITORY='fixture/fork',
                        GITHUB_REF='refs/heads/main', GITHUB_RUN_ID='123')
        workflow = (REPO / '.github/workflows/build-apk-source.yml').read_text(encoding='utf-8')
        paths = workflow.split('      - name: Upload intermediate APK and provenance\n', 1)[1].split('          path: |\n', 1)[1].split('          if-no-files-found:', 1)[0]
        self.apks = {}
        for abi in module.ABIS:
            for line in paths.splitlines():
                path = line.strip()
                if '*' not in path:
                    self.put(abi, path, '{}')
            self.put(abi, 'scripts/patches/tests/fixtures/test-0.2.2-rc.1/probe.js', 'fixture')
            self.put(abi, '.deploy-tmp/linux-build/provenance/linux-assets.json', '{}')
            apk = f'out/v1-source/pocket-harness-v1-source-{abi}.apk'
            self.apks[abi] = apk
            self.put(abi, apk, f'production signed {abi} APK bytes'.encode())
            base = '.deploy-tmp/source-build/'
            self.put(abi, base + 'project-source-commit.txt', self.env['GITHUB_SHA'])
            self.put(abi, base + 'project-component-provenance.json', json.dumps(dict(
                projectCommit=self.env['GITHUB_SHA'], sourceRepository='https://github.com/fixture/fork')))
            self.put(abi, base + 'component-source-provenance.json', json.dumps(dict(projectCommit=self.env['GITHUB_SHA'])))
            signed = hashlib.sha256(self.root.joinpath(abi, apk).read_bytes()).hexdigest()
            self.put(abi, base + 'apk-sha256.txt', f'{signed}  {apk}\n')
            self.put(abi, base + 'signing-certificate-sha256.txt', PINNED + '\n')
            self.put(abi, base + 'independent-rebuild-verification.json', json.dumps(dict(
                schemaVersion=2, runtime=module._abi.linux_abi(abi)['runtime'], abi=abi, independentRebuildMatched=True,
                sourceCommit=self.env['GITHUB_SHA'], payloadSha256=sha('payload-' + abi), primaryApkSha256=sha('primary-' + abi),
                referenceApkSha256=sha('reference-' + abi), signedApkSha256=signed)))

    def put(self, abi, path, data):
        target = self.root / abi / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data if isinstance(data, bytes) else data.encode('utf-8'))

    def run_prepare(self):
        module.prepare(self.root, self.output, self.env)

    def test_signed_dual_abi_apks_and_evidence_are_packaged_unchanged(self):
        self.run_prepare()
        for abi, apk in self.apks.items():
            self.assertEqual((self.root / abi / apk).read_bytes(), (self.output / Path(apk).name).read_bytes())
        with zipfile.ZipFile(self.output / 'provenance.zip') as archive:
            for abi in module.ABIS:
                self.assertIn(f'{abi}/.deploy-tmp/source-build/independent-rebuild-verification.json', archive.namelist())
                self.assertIn(f'{abi}/.deploy-tmp/linux-build/provenance/linux-assets.json', archive.namelist())
        for line in (self.output / 'SHA256SUMS.txt').read_text().splitlines():
            digest, name = line.split('  ')
            self.assertEqual(module.digest(self.output / name), digest)

    def test_fixture_release_notes_are_used_when_present(self):
        notes_dir = REPO / 'release/v1'
        notes_dir.mkdir(parents=True, exist_ok=True)
        notes = notes_dir / 'notes.md'
        self.addCleanup(notes_dir.rmdir)
        self.addCleanup(notes.unlink)
        notes.write_text('# Fixture release notes\n', encoding='utf-8')
        self.run_prepare()
        self.assertEqual((self.output / 'notes.md').read_text(), '# Fixture release notes\n')

    def test_negative_controls_reject_tampering_and_wrong_identity(self):
        cases = [
            ((self.apks['arm64'],), b'tampered APK'),
            ((self.apks['x86_64'],), b'tampered APK'),
            (('project-source-commit.txt',), 'b' * 40),
            (('project-component-provenance.json',), json.dumps(dict(
                projectCommit='a' * 40, sourceRepository='https://github.com/other/repo'))),
            (('signing-certificate-sha256.txt',), 'c' * 64 + '\n'),
            (('independent-rebuild-verification.json',), json.dumps(dict(
                schemaVersion=2, runtime='linux-arm64-glibc', abi='arm64', independentRebuildMatched=True,
                sourceCommit=self.env['GITHUB_SHA'], payloadSha256=sha('payload'), primaryApkSha256=sha('primary'),
                signedApkSha256=sha('other')))),
        ]
        for (path,), replacement in cases:
            with self.subTest(path=path):
                for abi in module.ABIS:
                    target = self.root / abi / '.deploy-tmp/source-build' / path if not path.endswith('.apk') else self.root / abi / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    original = target.read_bytes() if target.exists() else None
                    target.write_bytes(replacement if isinstance(replacement, bytes) else replacement.encode())
                    with self.assertRaises(ValueError):
                        self.run_prepare()
                    self.assertFalse(self.output.exists())
                    if original is None:
                        target.unlink()
                    else:
                        target.write_bytes(original)

    def test_non_main_ref_is_rejected(self):
        self.env['GITHUB_REF'] = 'refs/heads/codex/linux-runtime-experiment'
        with self.assertRaisesRegex(ValueError, 'invalid source branch'):
            self.run_prepare()

    def test_release_workflow_is_the_formal_dual_abi_draft_pipeline(self):
        workflow = (REPO / '.github/workflows/release-source-draft.yml').read_text(encoding='utf-8')
        self.assertIn('test "$SOURCE_REF" = refs/heads/main', workflow)
        self.assertIn('pocket-harness-arm64-source-${{ github.sha }}', workflow)
        self.assertIn('pocket-harness-x86_64-source-${{ github.sha }}', workflow)
        self.assertIn('--draft', workflow)
        self.assertIn('--prerelease', workflow)
        script = workflow.split("          python3 - <<'PY'\n")[-1].split('\n          PY\n')[0]
        script = '\n'.join(line[10:] if line.startswith(' ' * 10) else line for line in script.splitlines())
        with tempfile.TemporaryDirectory() as temporary:
            assets = Path(temporary)
            names = ['pocket-harness-v0.16.0-source-arm64.apk', 'pocket-harness-v0.16.0-source-x86_64.apk']
            for name in names:
                (assets / name).write_bytes(name.encode())
            (assets / 'provenance.zip').write_bytes(b'zip')
            (assets / 'notes.md').write_text('notes')
            rows = [f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}' for p in sorted(assets.iterdir())]
            (assets / 'SHA256SUMS.txt').write_text('\n'.join(rows) + '\n')
            self.assertEqual(subprocess.run(['python3', '-c', script], cwd=assets).returncode, 0)
            (assets / 'extra.apk').write_bytes(b'extra')
            self.assertNotEqual(subprocess.run(['python3', '-c', script], cwd=assets).returncode, 0)


if __name__ == '__main__':
    unittest.main()
