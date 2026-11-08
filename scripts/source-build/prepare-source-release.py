#!/usr/bin/env python3
"""Validate this run's dual-ABI source artifacts and package their evidence; never rebuild APKs."""
import hashlib
import glob
import json
import os
from pathlib import Path
import re
import shutil
import sys
import zipfile

ABIS = ('arm64', 'x86_64')


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def validate_abi(source, abi, sha, repo, server):
    source = Path(source)
    if source.is_symlink() or not source.is_dir():
        raise ValueError(f'missing {abi} source artifact directory')
    entries = list(source.rglob('*'))
    if any(p.is_symlink() for p in entries):
        raise ValueError(f'{abi} artifact symlink is not allowed')
    files = sorted(p for p in entries if p.is_file())

    # The upload list is the authority for required evidence. Hidden files must survive transfer.
    workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/build-apk-source.yml').read_text(encoding='utf-8')
    upload = workflow.split('      - name: Upload APK and provenance\n', 1)[1]
    paths = upload.split('          path: |\n', 1)[1].split('          if-no-files-found:', 1)[0]
    for pattern in (line.strip() for line in paths.splitlines() if line.strip()):
        matches = glob.glob(str(source / pattern), recursive=True)
        if not any(Path(match).is_file() for match in matches):
            raise ValueError(f'missing {abi} evidence: {pattern}')

    evidence = source / '.deploy-tmp/source-build'
    if (evidence / 'project-source-commit.txt').read_text(encoding='utf-8').strip() != sha:
        raise ValueError(f'{abi} source commit mismatch')
    project = json.loads((evidence / 'project-component-provenance.json').read_text(encoding='utf-8'))
    components = json.loads((evidence / 'component-source-provenance.json').read_text(encoding='utf-8'))
    if project['projectCommit'] != sha or components['projectCommit'] != sha:
        raise ValueError(f'{abi} provenance commit mismatch')
    if project['sourceRepository'] != server + '/' + repo:
        raise ValueError(f'{abi} source repository mismatch')

    apks = [p for p in files if p.suffix == '.apk']
    if len(apks) != 1 or not re.fullmatch(rf'pocket-harness-v[\w.+-]+-source-{re.escape(abi)}\.apk', apks[0].name):
        raise ValueError(f'expected exactly one source {abi} APK')
    apk = apks[0]
    proof = json.loads((evidence / 'independent-rebuild-verification.json').read_text(encoding='utf-8'))
    if (proof.get('abi') != abi or proof.get('independentRebuildMatched') is not True
            or proof.get('normalizationVersion') != 3 or proof.get('sourceCommit') != sha
            or proof.get('signedApkSha256') != digest(apk)):
        raise ValueError(f'{abi} independent rebuild proof does not bind the final APK')
    expected = f'{digest(apk)}  {apk.relative_to(source).as_posix()}'
    if expected not in (evidence / 'apk-sha256.txt').read_text(encoding='utf-8').splitlines():
        raise ValueError(f'{abi} APK hash mismatch')
    return source, files, apk


def prepare(source_root, output, env):
    source_root, output = Path(source_root), Path(output)
    sha, repo = env['GITHUB_SHA'], env['GITHUB_REPOSITORY']
    server = env.get('GITHUB_SERVER_URL', 'https://github.com').rstrip('/')
    if env['GITHUB_REF'] != 'refs/heads/main' or not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('invalid source branch or commit')
    if source_root.is_symlink() or not source_root.is_dir():
        raise ValueError('source artifact root must be a real directory')
    children = list(source_root.iterdir())
    if ({child.name for child in children} != set(ABIS)
            or any(child.is_symlink() or not child.is_dir() for child in children)):
        raise ValueError('source artifact root must contain only real arm64 and x86_64 directories')

    artifacts = {
        abi: validate_abi(source_root / abi, abi, sha, repo, server)
        for abi in ABIS
    }
    apk_versions = {re.fullmatch(r'pocket-harness-(v[\w.+-]+)-source-(?:arm64|x86_64)\.apk', row[2].name)[1]
                    for row in artifacts.values()}
    if len(apk_versions) != 1:
        raise ValueError('ARM64 and x86_64 APK version names do not match')

    # Do not overwrite a previous release preparation or accept partial output as success.
    output.mkdir(parents=True, exist_ok=False)
    assets = []
    with zipfile.ZipFile(output / 'provenance.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for abi, (source, files, apk) in artifacts.items():
            destination = output / apk.name
            shutil.copyfile(apk, destination)
            assets.append(destination)
            for path in files:
                if path != apk:
                    archive.write(path, f'{abi}/{path.relative_to(source).as_posix()}')

    notes = output / 'notes.md'
    notes.write_text(f'''Dual-ABI source build for main.

Commit: {sha}
Build: {server}/{repo}/actions/runs/{env['GITHUB_RUN_ID']}

Draft prerelease only. Device validation has NOT been performed for this candidate.
Includes ARM64 and x86_64 APKs, signed with the independent Pocket Harness signing identity.
The x86_64 build currently omits offline PRoot Linux assets and the Android Canvas native runtime;
use the ARM64 APK for those capabilities. Complete device acceptance before making this release public.

APK bytes are copied unchanged from this run's independently verified source builds. provenance.zip
contains the evidence for both ABIs under separate top-level directories; verify downloaded assets
with SHA256SUMS.txt.
''', encoding='utf-8')
    assets.append(notes)
    assets.append(output / 'provenance.zip')
    (output / 'SHA256SUMS.txt').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in assets), encoding='utf-8')


if __name__ == '__main__':
    prepare(sys.argv[1], sys.argv[2], os.environ)
