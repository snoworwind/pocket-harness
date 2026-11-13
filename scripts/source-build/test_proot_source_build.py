import hashlib
import importlib.util
import io
from pathlib import Path
import platform
import shutil
import stat
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SCRIPT = Path(__file__).with_name('build-proot-source.py')
SPEC = importlib.util.spec_from_file_location('proot_source_build', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

FIXTURE_SPEC = importlib.util.spec_from_file_location('native_fixture', Path(__file__).with_name('test_native_runtime_inventory.py'))
FIXTURE = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(FIXTURE)


def bundle_elf(name, machine=183):
    if name == MODULE.OUTPUTS[0]:
        return FIXTURE.elf(machine=machine, needed=('libtalloc.so', 'libandroid-shmem.so', 'libc.so'))
    if name == MODULE.OUTPUTS[1]:
        data = bytearray(FIXTURE.elf(machine=machine, interpreter=None, needed=()))
        struct.pack_into('<H', data, 16, 2)
        return bytes(data)
    data = bytearray(FIXTURE.elf(machine=machine, interpreter=None, needed=()))
    struct.pack_into('<Q', data, 24, 0)
    table = b'\0' + name.encode() + b'\0'
    data[768:768 + len(table)] = table
    struct.pack_into('<qQ', data, 528, 10, len(table))
    struct.pack_into('<qQ', data, 544, 14, 1)
    struct.pack_into('<qQ', data, 560, 0, 0)
    struct.pack_into('<Q', data, 152, 64)
    struct.pack_into('<Q', data, 160, 64)
    return bytes(data)


class SourceBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def bundle(self, abi='arm64'):
        directory = self.root / abi
        directory.mkdir(exist_ok=True)
        for name in MODULE.OUTPUTS:
            path = directory / name
            path.write_bytes(bundle_elf(name, MODULE.ABIS[abi][2]))
            path.chmod(0o755)
        return directory

    def test_gnu_awk_required_before_loader_generation(self):
        executable = self.root / 'gawk'
        executable.write_text('fixture GNU awk executable')
        class Result:
            returncode = 0
            stdout = 'GNU Awk 5.3.0\n'
        with patch.object(MODULE.shutil, 'which', return_value=str(executable)), patch.object(MODULE.subprocess, 'run', return_value=Result()):
            self.assertEqual(MODULE.require_gnu_awk()['sha256'], MODULE.native.sha256_file(executable))
        Result.returncode = 2
        Result.stdout = ''
        with patch.object(MODULE.shutil, 'which', return_value=str(executable)), patch.object(MODULE.subprocess, 'run', return_value=Result()):
            with self.assertRaisesRegex(ValueError, 'GNU awk'):
                MODULE.require_gnu_awk()
        with patch.object(MODULE.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(ValueError, 'GNU awk'):
                MODULE.require_gnu_awk()

    def test_fixed_sources_are_source_archives_not_termux_packages(self):
        records = MODULE.source_records()
        self.assertEqual(set(records), {'proot', 'libtalloc', 'libandroid-shmem'})
        for row in records.values():
            self.assertFalse(row['archive'].endswith('.deb'))
            self.assertEqual(len(row['sha256']), 64)
            self.assertNotIn('packages.termux.dev', row['url'])

    def test_both_abis_and_native_dependency_closure(self):
        for abi in MODULE.ABIS:
            rows = MODULE.check_bundle(self.bundle(abi), abi)
            self.assertEqual({row['name'] for row in rows}, set(MODULE.OUTPUTS))
            self.assertTrue(all(row['elf']['elf16kAligned'] for row in rows))

    def test_controlled_negative_wrong_abi_alignment_soname_and_loader(self):
        directory = self.bundle()
        for name, data, message in [
            (MODULE.OUTPUTS[0], bundle_elf(MODULE.OUTPUTS[0], machine=62), 'ELF/ABI'),
            (MODULE.OUTPUTS[1], FIXTURE.elf(), 'ELF/ABI'),
            (MODULE.OUTPUTS[2], bundle_elf('libwrong.so'), 'SONAME'),
            (MODULE.OUTPUTS[0], FIXTURE.elf(needed=('libunknown.so', 'libtalloc.so', 'libandroid-shmem.so')), 'unresolved'),
            (MODULE.OUTPUTS[0], FIXTURE.elf(alignment=4096), 'ELF/ABI'),
        ]:
            with self.subTest(name=name, message=message):
                self.bundle()
                (directory / name).write_bytes(data)
                with self.assertRaisesRegex(ValueError, message):
                    MODULE.check_bundle(directory, 'arm64')

    def test_missing_extra_linked_and_non_executable_outputs_are_rejected(self):
        directory = self.bundle()
        first = directory / MODULE.OUTPUTS[0]
        first.unlink()
        with self.assertRaisesRegex(ValueError, 'output set'):
            MODULE.check_bundle(directory, 'arm64')
        self.bundle()
        first.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'executable regular'):
            MODULE.check_bundle(directory, 'arm64')
        first.unlink()
        first.symlink_to(directory / MODULE.OUTPUTS[1])
        with self.assertRaisesRegex(ValueError, 'executable regular'):
            MODULE.check_bundle(directory, 'arm64')

    def test_source_extraction_rejects_traversal_and_symlinks(self):
        for index, (name, symlink) in enumerate([('../escape', False), ('source/file', True)]):
            archive = self.root / f'{index}.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                entry = zipfile.ZipInfo(name)
                if symlink:
                    entry.create_system = 3
                    entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                output.writestr(entry, 'outside')
            with self.assertRaisesRegex(ValueError, 'unsafe|links/special|link target'):
                MODULE.unpack_source(archive, self.root / f'extracted-{index}')
        self.assertFalse((self.root / 'escape').exists())

    def test_source_extraction_positive_and_patch_anchor_negative(self):
        archive = self.root / 'source.zip'
        with zipfile.ZipFile(archive, 'w') as output:
            output.writestr('source/file.c', 'original\n')
            entry = zipfile.ZipInfo('source/alias.c')
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            output.writestr(entry, 'file.c')
        directory = MODULE.unpack_source(archive, self.root / 'extracted')
        self.assertTrue((directory / 'alias.c').is_symlink())
        path = directory / 'file.c'
        result = MODULE.replace_once(path, 'original\n', 'patched\n')
        self.assertNotEqual(result['beforeSha256'], result['afterSha256'])
        with self.assertRaisesRegex(ValueError, 'anchor drift'):
            MODULE.replace_once(path, 'original\n', 'patched\n')
        self.assertEqual(path.read_text(), 'patched\n')

    def test_source_download_checks_bytes_before_publication_and_preserves_existing(self):
        record = {'fixture': dict(archive='source.zip', sha256=hashlib.sha256(b'good').hexdigest(), url='https://example.invalid/source.zip')}
        target = self.root / 'source.zip'
        with patch.object(MODULE, 'source_records', return_value=record):
            with patch.object(MODULE, 'urlopen', return_value=io.BytesIO(b'bad')):
                with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                    MODULE.fetch_sources(self.root)
            self.assertFalse(target.exists())
            target.write_bytes(b'preexisting')
            with self.assertRaisesRegex(ValueError, 'wrong identity'):
                MODULE.fetch_sources(self.root)
            self.assertEqual(target.read_bytes(), b'preexisting')
            target.unlink()
            with patch.object(MODULE, 'urlopen', return_value=io.BytesIO(b'good')):
                MODULE.fetch_sources(self.root)
            self.assertEqual(target.read_bytes(), b'good')

    def test_wrong_ndk_is_rejected_before_compilation(self):
        ndk = self.root / 'ndk'
        ndk.mkdir()
        (ndk / 'source.properties').write_text('Pkg.Revision = 1.0.0\n')
        with self.assertRaisesRegex(ValueError, 'pinned NDK'):
            MODULE.build(self.root, ndk, self.root / 'output', 'arm64')
        self.assertFalse((self.root / 'output').exists())

    def test_tampered_source_is_rejected_before_compiler_invocation(self):
        ndk = self.root / 'ndk'
        ndk.mkdir()
        (ndk / 'source.properties').write_text(f'Pkg.Revision = {MODULE.NDK_REVISION}\n')
        host = {'Linux': 'linux-x86_64', 'Darwin': 'darwin-x86_64'}[platform.system()]
        cc = ndk / 'toolchains/llvm/prebuilt' / host / 'bin/aarch64-linux-android26-clang'
        cc.parent.mkdir(parents=True)
        cc.write_text('must not execute\n')
        with patch.object(MODULE.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'source archive digest mismatch'):
                MODULE.build(self.root, ndk, self.root / 'output', 'arm64')
            run.assert_not_called()

    def test_shmem_runtime_path_helper_executes_positive_and_negative_cases(self):
        compiler = shutil.which('cc') or shutil.which('clang')
        self.assertIsNotNone(compiler, 'self-test requires a host C compiler')
        source = self.root / 'test.c'
        source.write_text(r'''
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include "pocket_shmem_path.h"
int main(void) {
    char path[256];
    unsetenv("TMPDIR"); unsetenv("PROOT_TMP_DIR");
    assert(pocket_shmem_key_path(path, sizeof(path), 7) == -1 && errno == EINVAL);
    setenv("TMPDIR", "/app/tmp", 1);
    assert(pocket_shmem_key_path(path, sizeof(path), 7) == 0);
    assert(strcmp(path, "/app/tmp/ashv_key_7") == 0);
    setenv("PROOT_TMP_DIR", "/app/proot/", 1);
    assert(pocket_shmem_key_path(path, sizeof(path), -9) == 0);
    assert(strcmp(path, "/app/proot/ashv_key_-9") == 0);
    setenv("PROOT_TMP_DIR", "relative", 1);
    assert(pocket_shmem_key_path(path, sizeof(path), 7) == -1 && errno == EINVAL);
    setenv("PROOT_TMP_DIR", "/app/proot", 1);
    assert(pocket_shmem_key_path(path, 2, 7) == -1 && errno == ENAMETOOLONG);
    char long_directory[300];
    memset(long_directory, 'a', sizeof(long_directory));
    long_directory[0] = '/'; long_directory[sizeof(long_directory) - 1] = '\0';
    setenv("PROOT_TMP_DIR", long_directory, 1);
    assert(pocket_shmem_key_path(path, sizeof(path), 7) == -1 && errno == ENAMETOOLONG);
    return 0;
}
''')
        executable = self.root / 'test'
        subprocess.run([compiler, '-std=c99', '-Wall', '-Wextra', '-Werror', '-I', str(MODULE.ADAPTERS), str(source), '-o', str(executable)], check=True, capture_output=True)
        subprocess.run([str(executable)], check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
