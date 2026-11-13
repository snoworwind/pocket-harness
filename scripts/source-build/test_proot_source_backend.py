"""Source-backend provenance positive cases and controlled rejection cases."""
import copy
import importlib.util
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from proot_source_provenance import builder, verify_backend, verify_receipt, PATCH_PATHS

SPEC = importlib.util.spec_from_file_location('source_backend', Path(__file__).with_name('prepare-proot-source-backend.py'))
assembler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(assembler)


def receipt():
    return dict(schemaVersion=1, sourceBuild=True, abi='arm64', androidApi=builder.API,
        ndkRevision=builder.NDK_REVISION, sources=builder.source_records(),
        buildVersion=builder.source_records()['proot']['version'] + '-pocket-source.1',
        buildScriptSha256=builder.native.sha256_file(builder.HERE / 'build-proot-source.py'),
        sourceLockSha256=builder.native.sha256_file(builder.HERE / 'linux-backend-packages.json'),
        adapterSha256={p.name: builder.native.sha256_file(p) for p in builder.ADAPTERS.iterdir() if p.is_file()},
        compilerExecutableSha256='c' * 64, ndkPropertiesSha256='d' * 64,
        sourcePatches={name: dict(beforeSha256='a'*64, afterSha256='b'*64) for name in PATCH_PATHS},
        nativeLibraries=[dict(name=name, size=1024, sha256='e'*64) for name in builder.OUTPUTS])


class BackendTests(unittest.TestCase):
    def test_current_recipe_receipt(self):
        self.assertEqual(len(verify_receipt(receipt())), 4)

    def test_receipt_rejects_changed_sources_recipe_and_native_members(self):
        for field, value in [('sourceBuild', False), ('abi', 'arm'), ('ndkRevision', 'old'),
                ('buildScriptSha256', 'f'*64), ('adapterSha256', {}), ('sourcePatches', {}),
                ('nativeLibraries', []), ('sources', {})]:
            candidate = receipt()
            candidate[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                verify_receipt(candidate)

    def fixture(self, root):
        r = receipt()
        path = root / 'proot-source-build-arm64.json'
        path.write_text(json.dumps(r))
        report = dict(schemaVersion=2, provenanceKind='source-build', target='proot', architecture='arm64',
            targetVersion=r['sources']['proot']['version'], sourceBuildReceipt=path.name,
            sourceBuildReceiptSha256=builder.native.sha256_file(path), nativeLibraries=verify_receipt(r),
            licenseOrigins=[dict(package=n, sourceArchiveSha256=row['sha256']) for n, row in r['sources'].items()])
        target = root / 'proot-backend-inputs.json'
        target.write_text(json.dumps(report))
        return target, report

    def test_backend_binds_receipt_and_rejects_masquerade(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, report = self.fixture(Path(temporary))
            self.assertEqual(verify_backend(path)[0], report)
            for field, value in [('repository', 'termux'), ('sourceBuildReceiptSha256', '0'*64),
                    ('nativeLibraries', []), ('licenseOrigins', []), ('sourceBuildReceipt', '../escape')]:
                candidate = copy.deepcopy(report)
                candidate[field] = value
                path.write_text(json.dumps(candidate))
                with self.subTest(field=field), self.assertRaises(ValueError):
                    verify_backend(path)

    def test_asset_builder_executes_provenance_cli_with_file_not_directory(self):
        script = builder.HERE / 'build-linux-assets.sh'
        line = next(line for line in script.read_text().splitlines()
                    if line.startswith('python3 scripts/source-build/proot_source_provenance.py '))
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            proof = work / 'provenance'
            proof.mkdir()
            self.fixture(proof)
            env = {**os.environ, 'WORK': str(work)}
            result = subprocess.run(['bash', '-c', line], cwd=builder.ROOT, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('PASS source-built PRoot provenance', result.stdout)
            bad = line.replace('/proot-backend-inputs.json', '')
            self.assertNotEqual(bad, line)
            rejected = subprocess.run(['bash', '-c', bad], cwd=builder.ROOT, env=env, capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn('backend provenance must be a regular file', rejected.stderr)

    def test_assembly_rejects_changed_binary_before_publishing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'proot-source-build-arm64.json').write_text(json.dumps(receipt()))
            with patch.object(builder, 'check_bundle', return_value=[]):
                with self.assertRaisesRegex(ValueError, 'compiled native bytes'):
                    assembler.assemble(root, root, root/'backend', root/'native', root/'proof')
            self.assertFalse((root/'backend').exists())
            self.assertFalse((root/'proof').exists())


if __name__ == '__main__':
    unittest.main()
