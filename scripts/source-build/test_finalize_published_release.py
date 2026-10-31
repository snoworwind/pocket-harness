import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import importlib.util


SCRIPT = Path(__file__).with_name('finalize-published-release.py')
SPEC = importlib.util.spec_from_file_location('finalize_published_release', SCRIPT)
FINALIZER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FINALIZER)


class FinalizePublishedReleaseTests(unittest.TestCase):
    def setUp(self):
        self.release = FINALIZER.fixture_release()
        self.notes = Path(__file__).resolve().parents[2] / 'release' / 'v0.14.10' / 'notes.md'

    def test_prepares_asset_bound_checksums_and_verifies_published_state(self):
        with tempfile.TemporaryDirectory() as temp:
            assets = Path(temp) / 'assets'
            FINALIZER.prepare(self.release, self.notes, assets)
            notes = (assets / FINALIZER.NOTES).read_bytes()
            sums = (assets / FINALIZER.SUMS).read_bytes()
            expected = FINALIZER.expected_sums(FINALIZER.asset_digests(self.release), notes)
            self.assertEqual(sums, expected)

            updated = copy.deepcopy(self.release)
            updated['body'] = notes.decode('utf-8').rstrip('\n')
            for asset in updated['assets']:
                if asset['name'] == FINALIZER.NOTES:
                    asset['digest'] = 'sha256:' + hashlib.sha256(notes).hexdigest()
                elif asset['name'] == FINALIZER.SUMS:
                    asset['digest'] = 'sha256:' + hashlib.sha256(sums).hexdigest()
            FINALIZER.verify(updated, assets)

    def test_rejects_non_target_or_unstable_release_metadata(self):
        mutations = [
            lambda value: value.update(tag_name='v0.14.10'),
            lambda value: value.update(draft=True),
            lambda value: value.update(prerelease=True),
            lambda value: value['assets'][0].update(digest='sha256:' + '0' * 64),
            lambda value: value['assets'].pop(),
        ]
        for mutate in mutations:
            candidate = copy.deepcopy(self.release)
            mutate(candidate)
            with self.subTest(candidate=candidate.get('tag_name')):
                with self.assertRaises(ValueError):
                    FINALIZER.asset_digests(candidate)

    def test_rejects_checksum_drift_after_preparation(self):
        with tempfile.TemporaryDirectory() as temp:
            assets = Path(temp) / 'assets'
            FINALIZER.prepare(self.release, self.notes, assets)
            (assets / FINALIZER.SUMS).write_text('0' * 64 + '  notes.md\n', encoding='utf-8')
            with self.assertRaises(ValueError):
                FINALIZER.verify(self.release, assets)


if __name__ == '__main__':
    unittest.main()
