"""Run the production CLI's self-test positive and negative controls in PR Gate."""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('production', Path(__file__).with_name('prepare-linux-runtime-release.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ReleaseTests = module.ReleaseTests

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest


class PublicationWorkflowTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'actual publication shell requires GNU Linux tools')
    def test_actual_publish_shell_uses_fixed_version_and_refuses_unchecked_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            source.mkdir()
            rows = []
            for index in range(5):
                name = f'payload-{index}.tar.xz'
                (source / name).write_bytes(b'payload')
                rows.append(dict(url=f'https://github.com/fixture/repo/releases/download/v0.15.3/{name}',
                                 size=7, sha256=hashlib.sha256(b'payload').hexdigest()))
            body = json.dumps(dict(version='0.15.3', plugins=dict(bootstrap=rows[0], runtime=rows[1]),
                runtimes=[dict(backendAsset=rows[2], rootfsAsset=rows[3], nodeAsset=rows[4])])).encode()
            (source / 'linux-release.json').write_bytes(body)
            (source / 'linux-runtime-manifest.sha256').write_text(hashlib.sha256(body).hexdigest())
            verified = root / 'linux-verified'
            module.prepare(source, verified, 'fixture/repo', 'a' * 40)
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            gh = bin_dir / 'gh'
            gh.write_text(f'#!{sys.executable}\nimport json,sys\nfrom pathlib import Path\nif sys.argv[1] == "api": print("Not Found (HTTP 404)", file=sys.stderr); sys.exit(1)\nif sys.argv[1:3] == ["release","view"]: sys.exit(1)\nif sys.argv[1:3] == ["release","create"]: Path("../calls.json").write_text(json.dumps(sys.argv[1:]))\nelif sys.argv[1:3] == ["release","edit"]: Path("../edit.json").write_text(json.dumps(sys.argv[1:]))\nelse: sys.exit(1)\n')
            gh.chmod(0o755)
            workflow = Path(__file__).resolve().parents[2] / 'docs/linux-env-findings/retired-workflows/publish-linux-runtime.yml'
            script = workflow.read_text().split('        run: |\n')[-1]
            script = '\n'.join(line[10:] if line.startswith('          ') else line for line in script.splitlines())
            env = {**os.environ, 'PATH': str(bin_dir) + ':' + os.environ['PATH'], 'GH_REPO': 'fixture/repo', 'SOURCE_COMMIT': 'a' * 40}
            result = subprocess.run(['bash', '-c', script], cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            args = json.loads((root / 'calls.json').read_text())
            self.assertEqual(args[:3], ['release', 'create', 'v0.15.3'])
            self.assertEqual(args[args.index('--target') + 1], 'a' * 40)
            self.assertIn('--latest=false', args)
            self.assertIn('--draft', args)
            self.assertIn('--draft=false', json.loads((root / 'edit.json').read_text()))
            (root / 'calls.json').unlink()
            for name in ['tag.txt', 'commit.txt', 'existing-ref.json', 'ref-error.txt']: (verified / name).unlink()
            (verified / 'unchecked.tar.xz').write_text('poison')
            result = subprocess.run(['bash', '-c', script], cwd=root, env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / 'calls.json').exists())
