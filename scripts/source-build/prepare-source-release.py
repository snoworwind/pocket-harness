#!/usr/bin/env python3
"""Validate this run's source artifact and package evidence; never rebuild APKs."""
import hashlib
import glob
import json
import os
from pathlib import Path
import re
import shutil
import sys
import zipfile


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prepare(source, output, env):
    source, output = Path(source), Path(output)
    sha, repo = env['GITHUB_SHA'], env['GITHUB_REPOSITORY']
    server = env.get('GITHUB_SERVER_URL', 'https://github.com').rstrip('/')
    if env['GITHUB_REF'] != 'refs/heads/main' or not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('invalid source branch or commit')
    files = sorted(p for p in source.rglob('*') if p.is_file())
    if any(p.is_symlink() for p in source.rglob('*')):
        raise ValueError('artifact symlink is not allowed')
    # The upload list is the authority for required evidence. Hidden files must survive transfer.
    workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/build-apk-source.yml').read_text()
    upload = workflow.split('      - name: Upload APK and provenance\n', 1)[1]
    paths = upload.split('          path: |\n', 1)[1].split('          if-no-files-found:', 1)[0]
    for pattern in (line.strip() for line in paths.splitlines() if line.strip()):
        # upload-artifact globs include directory contents recursively. pathlib.glob's
        # `**` behavior differs when the intermediate wildcard matches directories,
        # so use glob's explicit recursive mode and require an actual file match.
        matches = glob.glob(str(source / pattern), recursive=True)
        if not any(Path(match).is_file() for match in matches):
            raise ValueError('missing evidence: ' + pattern)
    evidence = source / '.deploy-tmp/source-build'
    if (evidence / 'project-source-commit.txt').read_text().strip() != sha:
        raise ValueError('source commit mismatch')
    project = json.loads((evidence / 'project-component-provenance.json').read_text())
    components = json.loads((evidence / 'component-source-provenance.json').read_text())
    if project['projectCommit'] != sha or components['projectCommit'] != sha:
        raise ValueError('provenance commit mismatch')
    if project['sourceRepository'] != server + '/' + repo:
        raise ValueError('source repository mismatch')
    apks = [p for p in files if p.suffix == '.apk']
    if len(apks) != 1 or not re.fullmatch(r'pocket-harness-v[\w.+-]+-source-arm64\.apk', apks[0].name):
        raise ValueError('expected exactly one source ARM64 APK')
    apk = apks[0]
    proof = json.loads((evidence / 'independent-rebuild-verification.json').read_text())
    if (proof.get('independentRebuildMatched') is not True or proof.get('normalizationVersion') != 3
            or proof.get('sourceCommit') != sha or proof.get('signedApkSha256') != digest(apk)):
        raise ValueError('independent rebuild proof does not bind the final APK')
    expected = f'{digest(apk)}  {apk.relative_to(source).as_posix()}'
    if expected not in (evidence / 'apk-sha256.txt').read_text().splitlines():
        raise ValueError('APK hash mismatch')
    # Do not overwrite a previous release preparation or accept partial output as success.
    output.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(apk, output / apk.name)
    with zipfile.ZipFile(output / 'provenance.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            if path != apk:
                archive.write(path, path.relative_to(source).as_posix())
    assets = [output / apk.name, output / 'provenance.zip']
    notes = output / 'notes.md'
    notes.write_text(f'''ARM64 source build for main.

Commit: {sha}
Build: {server}/{repo}/actions/runs/{env['GITHUB_RUN_ID']}

Draft prerelease only. Device validation has NOT been performed for this candidate.
ARM64 only; install on ARM64 Android devices. Uses the independent Pocket Harness signing identity.
Complete device acceptance before making this release public.

APK bytes are copied unchanged from this run's source build. provenance.zip contains
the same run's source evidence; verify downloaded assets with SHA256SUMS.txt.
''', encoding='utf-8')
    assets.append(notes)
    (output / 'SHA256SUMS.txt').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in assets), encoding='utf-8')


if __name__ == '__main__':
    prepare(sys.argv[1], sys.argv[2], os.environ)
