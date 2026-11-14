import importlib.util
from pathlib import Path
import unittest
import json
import subprocess
import sys
import tempfile
spec = importlib.util.spec_from_file_location('select_run', Path(__file__).with_name('select-linux-source-run.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SourceRunTests(unittest.TestCase):
    def test_source_identity_positive_and_negative_controls(self):
        valid = dict(repository=dict(full_name='owner/repo'), head_repository=dict(full_name='owner/repo'),
                     path='.github/workflows/release-source-draft.yml', head_branch='main',
                     status='completed', conclusion='success', event='workflow_dispatch', head_sha='a' * 40)
        self.assertEqual(module.select(valid, 'owner/repo'), 'a' * 40)
        for key, value in dict(repository=dict(full_name='fork/repo'), head_repository=dict(full_name='fork/repo'),
                               path='.github/workflows/build-apk-source.yml', head_branch='feature', status='in_progress',
                               conclusion='failure', event='pull_request', head_sha='main').items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                module.select({**valid, key:value}, 'owner/repo')

    def test_actual_cli_rejects_failed_run_without_emitting_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'run.json'
            source.write_text(json.dumps(dict(conclusion='failure')))
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('select-linux-source-run.py')), str(source), 'owner/repo'], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')
