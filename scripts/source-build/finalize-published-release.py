#!/usr/bin/env python3
"""Prepare and verify the already-published v0.14.10 release assets."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path


TAG = 'hardening-source-701773cdd2e4-41180533767-1'
TITLE = 'Pocket Harness v0.14.10 (DeepSeek Harness 0.2.1-rc.5)'
APK = 'pocket-harness-v0.14.10-source-arm64.apk'
PROVENANCE = 'provenance.zip'
NOTES = 'notes.md'
SUMS = 'SHA256SUMS.txt'
EXPECTED_APK_SHA256 = 'bd99ac410362e5bba7b85845f2c1e35a196dd030ff8e40b62dd83bcab2d8785d'
EXPECTED_PROVENANCE_SHA256 = 'afdef1def24ccb1824554b3a16554bac3c39f837224563271f077a7ff1b2cd17'
EXPECTED_ASSETS = {APK, PROVENANCE, NOTES, SUMS}
DIGEST_RE = re.compile(r'^sha256:([0-9a-f]{64})$')


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def asset_digests(release: dict) -> dict[str, str]:
    require(release.get('tag_name') == TAG, 'release tag does not match the v0.14.10 target')
    require(release.get('draft') is False, 'release must already be public')
    require(release.get('prerelease') is False, 'release must not be a prerelease')
    assets = release.get('assets')
    require(isinstance(assets, list), 'release assets are missing')
    names = [asset.get('name') for asset in assets if isinstance(asset, dict)]
    require(len(names) == len(assets) and len(names) == len(EXPECTED_ASSETS), 'release asset set is not exact')
    require(set(names) == EXPECTED_ASSETS, 'release asset names differ from the verified source build')

    result = {}
    for asset in assets:
        match = DIGEST_RE.fullmatch(asset.get('digest', ''))
        require(match is not None, f"GitHub did not provide a SHA-256 digest for {asset['name']}")
        result[asset['name']] = match[1]

    require(result[APK] == EXPECTED_APK_SHA256, 'published APK digest differs from the verified release asset')
    require(result[PROVENANCE] == EXPECTED_PROVENANCE_SHA256, 'published provenance digest differs from the verified release asset')
    return result


def validate_notes(notes: bytes) -> str:
    try:
        text = notes.decode('utf-8')
    except UnicodeDecodeError as error:
        raise ValueError('release notes must be UTF-8') from error
    require(f'正式发布 APK SHA-256：`{EXPECTED_APK_SHA256}`' in text, 'release notes must bind the published APK digest')
    require('Pocket Harness v0.14.10 正式发布' in text, 'release notes do not identify the formal release')
    require('设备验收尚未完成' in text, 'release notes must disclose incomplete device acceptance')
    require('预发布草稿' not in text and '不要将此草稿' not in text, 'release notes still contain draft-only wording')
    return text


def expected_sums(digests: dict[str, str], notes: bytes) -> bytes:
    rows = [
        f'{digests[APK]}  {APK}',
        f'{digests[PROVENANCE]}  {PROVENANCE}',
        f'{sha256(notes)}  {NOTES}',
    ]
    return ('\n'.join(rows) + '\n').encode('utf-8')


def prepare(release: dict, notes_path: Path, output_dir: Path) -> None:
    digests = asset_digests(release)
    notes = notes_path.read_bytes().replace(b'\r\n', b'\n')
    validate_notes(notes)
    output_dir.mkdir(parents=True, exist_ok=False)
    (output_dir / NOTES).write_bytes(notes)
    (output_dir / SUMS).write_bytes(expected_sums(digests, notes))
    shutil.copyfile(Path(__file__).resolve(), output_dir / 'verify-release.py')


def verify(release: dict, assets_dir: Path) -> None:
    digests = asset_digests(release)
    notes = (assets_dir / NOTES).read_bytes()
    text = validate_notes(notes)
    sums = (assets_dir / SUMS).read_bytes()
    require(sums == expected_sums(digests, notes), 'checksum file does not match the published APK, provenance, and notes')
    require(digests[NOTES] == sha256(notes), 'GitHub notes asset digest does not match the replacement file')
    require(digests[SUMS] == sha256(sums), 'GitHub checksum asset digest does not match the replacement file')
    require(release.get('name') == TITLE, 'release title differs from the v0.14.10 title')
    require(release.get('body', '').rstrip('\n') == text.rstrip('\n'), 'published release body differs from notes.md')


def fixture_release() -> dict:
    return {
        'tag_name': TAG,
        'name': TITLE,
        'draft': False,
        'prerelease': False,
        'body': 'old draft-time body',
        'assets': [
            {'name': APK, 'digest': f'sha256:{EXPECTED_APK_SHA256}'},
            {'name': PROVENANCE, 'digest': f'sha256:{EXPECTED_PROVENANCE_SHA256}'},
            {'name': NOTES, 'digest': 'sha256:' + '1' * 64},
            {'name': SUMS, 'digest': 'sha256:' + '2' * 64},
        ],
    }


def self_test() -> None:
    root = Path(__file__).resolve().parents[2]
    notes_path = root / 'release' / 'v0.14.10' / NOTES
    release = fixture_release()
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / 'assets'
        prepare(release, notes_path, output)
        notes = (output / NOTES).read_bytes()
        sums = (output / SUMS).read_bytes()
        validate_notes(notes)
        require(sums == expected_sums(asset_digests(release), notes), 'self-test checksum generation failed')
        after = copy.deepcopy(release)
        after['body'] = notes.decode('utf-8').rstrip('\n')
        for asset in after['assets']:
            if asset['name'] == NOTES:
                asset['digest'] = f'sha256:{sha256(notes)}'
            elif asset['name'] == SUMS:
                asset['digest'] = f'sha256:{sha256(sums)}'
        verify(after, output)


def self_test_negative() -> None:
    base = fixture_release()
    mutations = [
        lambda value: value.update(tag_name='another-release'),
        lambda value: value.update(draft=True),
        lambda value: value.update(prerelease=True),
        lambda value: value['assets'][0].update(digest='sha256:' + '0' * 64),
        lambda value: value['assets'].pop(),
    ]
    for mutate in mutations:
        candidate = copy.deepcopy(base)
        mutate(candidate)
        try:
            asset_digests(candidate)
        except ValueError:
            continue
        raise ValueError('negative self-test unexpectedly accepted invalid release metadata')


def main(args: list[str]) -> int:
    try:
        if args == ['--self-test']:
            self_test()
            print('published release asset preparation self-test passed')
        elif args == ['--self-test-negative']:
            self_test_negative()
            print('published release asset preparation negative self-test passed')
        elif len(args) == 4 and args[0] == '--prepare':
            release = json.loads(Path(args[1]).read_text(encoding='utf-8'))
            prepare(release, Path(args[2]), Path(args[3]))
        elif len(args) == 3 and args[0] == '--verify':
            release = json.loads(Path(args[1]).read_text(encoding='utf-8'))
            verify(release, Path(args[2]))
            print('published release metadata and assets verified')
        else:
            print('usage: finalize-published-release.py --self-test | --self-test-negative | --prepare <release.json> <notes.md> <output-dir> | --verify <release.json> <assets-dir>', file=sys.stderr)
            return 2
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
