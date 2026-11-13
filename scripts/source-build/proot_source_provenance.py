"""Shared source-backend provenance policy for assembly, notices and APK checks."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('pocket_proot_builder', HERE / 'build-proot-source.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
PATCH_PATHS = {
    'libtalloc/wscript',
    'libandroid-shmem/shmem.c',
    'proot/src/extension/ashmem_memfd/ashmem_memfd.c',
    'proot/src/loader/loader.c',
    'proot/src/loader/assembly-arm64.h',
    'proot/src/loader/assembly-x86_64.h',
    'proot/src/tracee/event.c',
    'proot/src/tracee/tracee.c',
}


def verify_receipt(receipt):
    if (receipt.get('schemaVersion') != 1 or receipt.get('sourceBuild') is not True
            or receipt.get('abi') not in builder.ABIS or receipt.get('androidApi') != builder.API
            or receipt.get('ndkRevision') != builder.NDK_REVISION):
        raise ValueError('source receipt schema/ABI/toolchain mismatch')
    if receipt.get('sources') != builder.source_records():
        raise ValueError('source receipt does not match pinned source identities')
    if (receipt.get('buildScriptSha256') != builder.native.sha256_file(HERE / 'build-proot-source.py')
            or receipt.get('sourceLockSha256') != builder.native.sha256_file(HERE / 'linux-backend-packages.json')
            or receipt.get('adapterSha256') != {p.name: builder.native.sha256_file(p) for p in builder.ADAPTERS.iterdir() if p.is_file()}):
        raise ValueError('source receipt recipe/adapter digest mismatch')
    if receipt.get('buildVersion') != builder.source_records()['proot']['version'] + '-pocket-source.1':
        raise ValueError('source receipt build version mismatch')
    patches = receipt.get('sourcePatches', {})
    if set(patches) != PATCH_PATHS:
        raise ValueError('source receipt patch set mismatch')
    for row in patches.values():
        if (not isinstance(row, dict) or any(not re.fullmatch('[a-f0-9]{64}', row.get(key, '')) for key in ('beforeSha256', 'afterSha256'))
                or row['beforeSha256'] == row['afterSha256']):
            raise ValueError('invalid source patch evidence')
    for key in ('compilerExecutableSha256', 'ndkPropertiesSha256'):
        if not re.fullmatch('[a-f0-9]{64}', receipt.get(key, '')):
            raise ValueError('source receipt compiler identity missing')
    libraries = receipt.get('nativeLibraries')
    if (not isinstance(libraries, list) or len(libraries) != len(builder.OUTPUTS)
            or {row.get('name') for row in libraries if isinstance(row, dict)} != set(builder.OUTPUTS)):
        raise ValueError('source receipt native member set mismatch')
    for row in libraries:
        if (not isinstance(row.get('size'), int) or isinstance(row['size'], bool) or not 0 < row['size'] <= 64 * 1024 * 1024
                or not re.fullmatch('[a-f0-9]{64}', row.get('sha256', ''))):
            raise ValueError('invalid source receipt native member identity')
    return [{key: row[key] for key in ('name', 'size', 'sha256')} for row in libraries]


def verify_backend(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('backend provenance must be a regular file')
    report = json.loads(path.read_text())
    if report.get('schemaVersion') != 2 or report.get('provenanceKind') != 'source-build' or report.get('target') != 'proot':
        raise ValueError('unsupported source backend provenance')
    if any(key in report for key in ('repository', 'packages', 'signedIndex', 'patchedTallocNeeded')):
        raise ValueError('source backend must not masquerade as signed Termux packages')
    abi = report.get('architecture')
    if abi not in builder.ABIS or report.get('targetVersion') != builder.source_records()['proot']['version']:
        raise ValueError('source backend target version/ABI mismatch')
    filename = f'proot-source-build-{abi}.json'
    receipt_path = path.parent / filename
    if (report.get('sourceBuildReceipt') != filename or receipt_path.is_symlink() or not receipt_path.is_file()
            or builder.native.sha256_file(receipt_path) != report.get('sourceBuildReceiptSha256')):
        raise ValueError('source build receipt identity mismatch')
    receipt = json.loads(receipt_path.read_text())
    libraries = verify_receipt(receipt)
    if receipt['abi'] != abi or report.get('nativeLibraries') != libraries:
        raise ValueError('backend native identities differ from the source receipt')
    origins = report.get('licenseOrigins', [])
    if len(origins) != len(builder.SOURCES) or {row.get('package') for row in origins} != set(builder.SOURCES):
        raise ValueError('source license origin set mismatch')
    for row in origins:
        if row.get('sourceArchiveSha256') != receipt['sources'][row['package']]['sha256']:
            raise ValueError('license origin differs from the pinned source archive')
    return report, receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('provenance')
    args = parser.parse_args()
    try:
        verify_backend(args.provenance)
        print('PASS source-built PRoot provenance')
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
