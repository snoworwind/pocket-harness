#!/usr/bin/env python3
"""Compare independent Linux APK payloads, ignoring only JAR signature records."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import zipfile

spec = importlib.util.spec_from_file_location('linux_payload', Path(__file__).with_name('verify-linux-payload.py'))
payload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(payload)


def contents(apk):
    payload.verify(apk)
    result = {}
    with zipfile.ZipFile(apk) as archive:
        for item in archive.infolist():
            if item.is_dir() or re.fullmatch(r'META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))', item.filename, re.I):
                continue
            with archive.open(item) as stream:
                result[item.filename] = hashlib.file_digest(stream, 'sha256').hexdigest()
    return result


def compare(primary, reference):
    if Path(primary).resolve() == Path(reference).resolve():
        raise ValueError('independent comparison requires different APK inputs')
    left, right = contents(primary), contents(reference)
    if left != right:
        changed = sorted(key for key in left.keys() | right.keys() if left.get(key) != right.get(key))
        raise ValueError('independent Linux APK payload differs: ' + ', '.join(changed[:20]))
    return dict(schemaVersion=2, runtime='linux-arm64-glibc', independentRebuildMatched=True,
                payloadSha256=hashlib.sha256(json.dumps(left, sort_keys=True).encode()).hexdigest(),
                apkPayloadFiles=len(left))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--primary', default='out')
    parser.add_argument('--reference', default='.deploy-tmp/independent-reference/out')
    args = parser.parse_args()
    files = [list(Path(directory).rglob('*.apk')) for directory in (args.primary, args.reference)]
    if any(len(items) != 1 for items in files):
        parser.error('require exactly one APK per independent builder')
    result = compare(files[0][0], files[1][0])
    sha = os.environ.get('GITHUB_SHA', '')
    if not re.fullmatch('[a-f0-9]{40}', sha):
        parser.error('source commit is required')
    result.update(schemaVersion=2, sourceCommit=sha, abi='arm64',
                  primaryApkSha256=hashlib.sha256(Path(files[0][0]).read_bytes()).hexdigest(),
                  referenceApkSha256=hashlib.sha256(Path(files[1][0]).read_bytes()).hexdigest())
    Path('.deploy-tmp/source-build/independent-rebuild-verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print('Independent Linux APK payloads match: ' + result['payloadSha256'])


if __name__ == '__main__':
    main()
