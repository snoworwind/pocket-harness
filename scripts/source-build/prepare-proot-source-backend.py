#!/usr/bin/env python3
"""Assemble verified source-built PRoot, source licenses and retained source inputs."""
import argparse
import json
from pathlib import Path
import shutil
import tempfile
import sys
import unittest

from proot_source_provenance import builder, verify_backend, verify_receipt


def assemble(build_root, sources_dir, backend, native_root, provenance, abi='arm64'):
    build_root, sources_dir = builder.real_directory(build_root), builder.real_directory(sources_dir)
    backend, native_root, provenance = map(Path, (backend, native_root, provenance))
    receipt_path = build_root / f'proot-source-build-{abi}.json'
    if receipt_path.is_symlink() or not receipt_path.is_file():
        raise ValueError('source receipt must be a regular file')
    receipt = json.loads(receipt_path.read_text())
    libraries = verify_receipt(receipt)
    if receipt['abi'] != abi:
        raise ValueError('source receipt ABI mismatch')
    source_native = build_root / 'native-libs' / builder.ABIS[abi][0]
    actual = builder.check_bundle(source_native, abi)
    if actual != receipt['nativeLibraries']:
        raise ValueError('compiled native bytes/ELF differ from source receipt')
    if backend.exists() or backend.is_symlink() or native_root.exists() or native_root.is_symlink():
        raise ValueError('backend/native destination must not already exist')
    # Validate original archives and replay patches before publishing any payload.
    with tempfile.TemporaryDirectory(prefix='proot-source-assembly-') as temporary:
        root = Path(temporary)
        sources = {}
        for name, row in receipt['sources'].items():
            archive = sources_dir / row['archive']
            if archive.is_symlink() or not archive.is_file() or builder.native.sha256_file(archive) != row['sha256']:
                raise ValueError('original source archive digest mismatch: ' + name)
            sources[name] = builder.unpack_source(archive, root / name)
        if builder.patch_sources(sources) != receipt['sourcePatches']:
            raise ValueError('source patch replay differs from receipt')
        provenance.mkdir(parents=True, exist_ok=True)
        provenance = builder.real_directory(provenance)
        report_path = provenance / 'proot-backend-inputs.json'
        receipt_copy = provenance / receipt_path.name
        archive_root = provenance / 'proot-source-archives'
        if any(path.exists() or path.is_symlink() for path in (report_path, receipt_copy, archive_root)):
            raise ValueError('source provenance destination must be fresh')
        for sub in ('bin', 'lib', 'libexec/proot', 'share/licenses'):
            (backend / sub).mkdir(parents=True, exist_ok=True)
        target_native = native_root / builder.ABIS[abi][0]
        target_native.mkdir(parents=True)
        mapping = dict(zip(builder.OUTPUTS, ('bin/proot', 'libexec/proot/loader', 'lib/libtalloc.so', 'lib/libandroid-shmem.so')))
        for name, relative in mapping.items():
            for target in (backend / relative, target_native / name):
                shutil.copyfile(source_native / name, target)
                target.chmod(0o755)
        licenses = backend / 'share/licenses'
        origins = []
        for name, filename in (('proot', 'COPYING'), ('libtalloc', 'LICENSE'), ('libandroid-shmem', 'LICENSE')):
            target = licenses / name / filename
            target.parent.mkdir()
            shutil.copyfile(sources[name] / filename, target)
            origins.append(dict(package=name, path=f'{name}/{filename}', upstreamPath=filename,
                                sourceArchiveSha256=receipt['sources'][name]['sha256']))
        # LGPLv3 incorporates GPLv3; ship both complete texts.
        shutil.copyfile(builder.ROOT / 'LICENSES/GPL-3.0.txt', licenses / 'libtalloc/GPL-3.0.txt')
        shim = builder.ROOT / 'vendor/linux-proot/compat'
        (licenses / 'pocket-harness-termfold-compat').mkdir()
        for name in ('LICENSE', 'NOTICE.md'):
            shutil.copyfile(shim / name, licenses / 'pocket-harness-termfold-compat' / name)
        (licenses / 'pocket-harness-source-adapter').mkdir()
        shutil.copyfile(builder.ROOT / 'LICENSE', licenses / 'pocket-harness-source-adapter/LICENSE')
        shutil.copyfile(builder.ROOT / 'LICENSES/GPL-2.0.txt', backend / 'LICENSE-GPL-2.0.txt')
        archive_root.mkdir()
        for row in receipt['sources'].values():
            shutil.copyfile(sources_dir / row['archive'], archive_root / row['archive'])
        shutil.copyfile(receipt_path, receipt_copy)
        report = dict(schemaVersion=2, provenanceKind='source-build', target='proot', architecture=abi,
            targetVersion=receipt['sources']['proot']['version'], sourceBuildReceipt=receipt_copy.name,
            sourceBuildReceiptSha256=builder.native.sha256_file(receipt_copy), nativeLibraries=libraries,
            licenseOrigins=origins,
            compatibilityShim={**json.loads((shim / 'SOURCE.json').read_text()),
                               'localSourceSha256': builder.native.sha256_file(shim / 'termfold_compat.c')},
            licenseFiles=[dict(path=p.relative_to(licenses).as_posix(), size=p.stat().st_size, sha256=builder.native.sha256_file(p))
                          for p in sorted(licenses.rglob('*')) if p.is_file()])
        with report_path.open('x') as stream:
            json.dump(report, stream, indent=2)
            stream.write('\n')
        verify_backend(report_path)
        return report


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.discover(str(builder.HERE), pattern='test_proot_source_backend.py'))
        raise SystemExit(0 if result.wasSuccessful() and result.testsRun and not result.skipped else 1)
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('build_root', 'sources', 'backend', 'native_root', 'provenance'):
        parser.add_argument(name)
    parser.add_argument('--abi', choices=builder.ABIS, default='arm64')
    args = parser.parse_args()
    try:
        assemble(args.build_root, args.sources, args.backend, args.native_root, args.provenance, args.abi)
        print('PASS source-built PRoot backend assembly')
    except (ValueError, OSError, KeyError, TypeError) as error:
        raise SystemExit(str(error))
