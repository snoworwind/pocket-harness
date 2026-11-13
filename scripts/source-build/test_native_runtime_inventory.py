import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).with_name('inventory-native-runtime.py')
SPEC = importlib.util.spec_from_file_location('native_inventory', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def elf(machine=183, interpreter='/system/bin/linker64', needed=('libc.so',), alignment=16384):
    """Small ELF64 fixture with file-backed dynamic strings and valid entry."""
    data = bytearray(1024)
    data[:16] = b'\x7fELF\x02\x01\x01' + bytes(9)
    phnum = 3 if interpreter else 2
    struct.pack_into('<HHIQQQIHHHHHH', data, 16, 3, machine, 1, 0x100, 64, 0, 0, 64, 56, phnum, 0, 0, 0)
    struct.pack_into('<IIQQQQQQ', data, 64, 1, 5, 0, 0, 0, len(data), len(data), alignment)
    table = b'\0' + b''.join(name.encode() + b'\0' for name in needed)
    data[768:768 + len(table)] = table
    tags = [(5, 768), (10, len(table))]
    offset = 1
    for name in needed:
        tags.append((1, offset))
        offset += len(name) + 1
    tags.append((0, 0))
    for index, (tag, value) in enumerate(tags):
        struct.pack_into('<qQ', data, 512 + index * 16, tag, value)
    struct.pack_into('<IIQQQQQQ', data, 120, 2, 4, 512, 512, 512, len(tags) * 16, len(tags) * 16, 8)
    if interpreter:
        raw = interpreter.encode() + b'\0'
        data[384:384 + len(raw)] = raw
        struct.pack_into('<IIQQQQQQ', data, 176, 3, 4, 384, 384, 384, len(raw), len(raw), 1)
    return bytes(data)


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'snapshot'
        (self.root / 'usr/bin').mkdir(parents=True)
        for name in ('node', 'bash'):
            self.write('usr/bin/' + name, elf())

    def write(self, path, data, mode=0o755):
        dest = self.root / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        dest.chmod(mode)
        return dest

    def scan(self, **kwargs):
        return MODULE.inventory(self.root, **{'abi': 'arm64', **kwargs})

    def test_complete_walk_includes_non_executable_modules_scripts_and_helper_names(self):
        self.write('usr/lib/pkg/pty.node', elf(interpreter=None), 0o644)
        self.write('usr/libexec/git-core/git-remote-https', elf())
        self.write('usr/bin/npm', b'#!/usr/bin/env node\nconsole.log(1)\n')
        self.write('usr/bin/unknown', b'opaque executable\n')
        self.write('usr/share/data.txt', b'not executable\n', 0o644)
        report = self.scan()
        self.assertEqual(report['counts']['elf'], 4)
        self.assertEqual(report['counts']['script'], 1)
        self.assertEqual(report['counts']['unclassified-executable'], 1)
        rows = {row['path']: row for row in report['payloads']}
        self.assertIn('usr/lib/pkg/pty.node', rows)
        self.assertNotIn('usr/share/data.txt', rows)
        self.assertEqual(rows['usr/bin/node']['elf']['needed'], ['libc.so'])
        self.assertEqual(report['phase'], 'inventory-only')
        self.assertEqual(report, self.scan())

    def test_symlink_resolution_is_lexical_and_never_reads_external_tree(self):
        (self.root / 'usr/bin/node').unlink()
        self.write('usr/lib/node-real', elf())
        os.symlink('../lib/node-real', self.root / 'usr/bin/node')
        os.symlink(MODULE.DEFAULT_PREFIX + '/bin/bash', self.root / 'usr/bin/sh')
        os.symlink('/data/data/com.snoworwind.pocketharness/files/usr/bin/bash', self.root / 'usr/bin/bash-alias')
        external = Path(self.temporary.name) / 'external'
        external.mkdir()
        (external / 'malformed').write_bytes(b'\x7fELFbad')
        os.symlink(external, self.root / 'outside')
        os.symlink('loop2', self.root / 'usr/bin/loop1')
        os.symlink('loop1', self.root / 'usr/bin/loop2')
        os.symlink('../../../escape', self.root / 'usr/bin/escape')
        os.symlink('missing', self.root / 'usr/bin/broken')
        report = self.scan()
        rows = {row['path']: row for row in report['payloads']}
        self.assertEqual(report['requiredCommands']['node'], 'usr/lib/node-real')
        self.assertEqual(rows['usr/bin/sh']['resolution']['target'], 'usr/bin/bash')
        self.assertEqual(rows['usr/bin/bash-alias']['resolution']['target'], 'usr/bin/bash')
        self.assertEqual(rows['outside']['resolution']['status'], 'external')
        self.assertEqual(rows['usr/bin/loop1']['resolution']['status'], 'cycle')
        self.assertEqual(rows['usr/bin/escape']['resolution']['status'], 'escape')
        self.assertEqual(rows['usr/bin/broken']['resolution']['status'], 'missing')

    def test_required_command_through_directory_link(self):
        (self.root / 'usr/bin/node').unlink()
        self.write('usr/actual/node', elf())
        os.symlink('actual', self.root / 'usr/toolchain')
        os.symlink('../toolchain/node', self.root / 'usr/bin/node')
        self.assertEqual(self.scan()['requiredCommands']['node'], 'usr/actual/node')

    def test_glibc_rootfs_uses_guest_absolute_links_without_reading_host(self):
        (self.root / 'usr/bin/node').unlink()
        self.write('usr/bin/bash', elf(interpreter='/lib/ld-linux-aarch64.so.1', needed=('libc.so.6',)))
        os.symlink('/usr/bin', self.root / 'bin')
        os.symlink('/bin/bash', self.root / 'usr/bin/sh')
        report = self.scan(layout='linux-rootfs')
        self.assertEqual(report['requiredCommands'], {'bash': 'usr/bin/bash'})
        rows = {row['path']: row for row in report['payloads']}
        self.assertEqual(rows['usr/bin/sh']['resolution']['target'], 'usr/bin/bash')
        self.assertEqual(rows['usr/bin/bash']['migrationStatus'], 'guest-payload')
        self.assertNotIn('proposedApkName', rows['usr/bin/bash'])
        self.assertIsNone(report['devicePrefix'])
        with self.assertRaisesRegex(ValueError, 'required command'):
            self.scan()

    def test_linux_node_archive_layout_and_bionic_negative(self):
        node = Path(self.temporary.name) / 'node'
        (node / 'bin').mkdir(parents=True)
        path = node / 'bin/node'
        path.write_bytes(elf(interpreter='/lib/ld-linux-aarch64.so.1', needed=('libc.so.6',)))
        path.chmod(0o755)
        report = MODULE.inventory(node, 'arm64', layout='linux-node')
        self.assertEqual(report['requiredCommands'], {'node': 'bin/node'})
        path.write_bytes(elf())
        with self.assertRaisesRegex(ValueError, 'required command node'):
            MODULE.inventory(node, 'arm64', layout='linux-node')

    def test_names_do_not_collide_and_changes_change_digest(self):
        self.write('usr/lib/helper/node', elf())
        first = self.scan()
        names = [row['proposedApkName'] for row in first['payloads'] if row['kind'] == 'elf']
        self.assertEqual(len(names), len(set(names)))
        self.write('usr/bin/node', elf(needed=('libc.so', 'libz.so')))
        self.assertNotEqual(first['inventorySha256'], self.scan()['inventorySha256'])

    def test_controlled_negative_wrong_abi_missing_command_no_exec_and_linux_interpreter(self):
        for data, mode in [(elf(machine=62), 0o755), (elf(), 0o644),
                           (elf(interpreter='/lib/ld-linux-aarch64.so.1', needed=('libc.so.6',)), 0o755),
                           (b'#!/system/bin/sh\n', 0o755)]:
            with self.subTest(mode=mode, header=data[:20]):
                self.write('usr/bin/node', data, mode)
                with self.assertRaisesRegex(ValueError, 'required command node'):
                    self.scan()
        (self.root / 'usr/bin/node').unlink()
        with self.assertRaisesRegex(ValueError, 'required command node'):
            self.scan()

    def test_dormant_linux_module_is_reported_not_misrepresented_as_android(self):
        self.write('usr/lib/optional/system.node', elf(interpreter=None, needed=('libc.so.6',)), 0o644)
        row = next(row for row in self.scan()['payloads'] if row['path'].endswith('system.node'))
        self.assertEqual(row['elf']['environment'], 'non-android')
        self.assertEqual(row['migrationStatus'], 'pending')

    def test_relocatable_build_input_is_not_proposed_as_executable(self):
        data = bytearray(elf())
        struct.pack_into('<H', data, 16, 1)
        struct.pack_into('<Q', data, 24, 0)
        struct.pack_into('<H', data, 56, 0)
        self.write('usr/lib/crtbegin.o', data, 0o644)
        row = next(row for row in self.scan()['payloads'] if row['path'].endswith('.o'))
        self.assertEqual(row['migrationStatus'], 'build-input')
        self.assertNotIn('proposedApkName', row)

    def test_x86_and_page_alignment(self):
        for name in ('node', 'bash'):
            self.write('usr/bin/' + name, elf(machine=62, alignment=4096))
        report = self.scan(abi='x86_64')
        self.assertTrue(all(not row['elf']['elf16kAligned'] for row in report['payloads']))
        self.assertEqual(MODULE.elf_metadata(elf())['elf16kAligned'], True)

    def test_elf32_static_loader_is_inventoried_but_cannot_satisfy_64bit_command(self):
        data = bytearray(128)
        data[:16] = b'\x7fELF\x01\x01\x01' + bytes(9)
        struct.pack_into('<HHIIIIIHHHHHH', data, 16, 2, 40, 1, 100, 52, 0, 0, 52, 32, 1, 0, 0, 0)
        struct.pack_into('<IIIIIIII', data, 52, 1, 0, 0, 0, len(data), len(data), 5, 4096)
        parsed = MODULE.elf_metadata(data)
        self.assertEqual((parsed['bits'], parsed['architecture']), (32, 'arm'))
        self.assertEqual(parsed['environment'], 'unclassified')
        self.write('usr/bin/node', data)
        with self.assertRaisesRegex(ValueError, 'required command node'):
            self.scan()

    def test_malformed_elf_bounds_and_dynamic_strings_are_rejected(self):
        variants = [b'\x7fELF']
        data = bytearray(elf())
        struct.pack_into('<Q', data, 32, len(data) - 1)
        variants.append(data)
        data = bytearray(elf())
        struct.pack_into('<Q', data, 96, len(data) + 1)
        variants.append(data)
        data = bytearray(elf())
        struct.pack_into('<Q', data, 552, 10000)
        variants.append(data)
        data = bytearray(elf())
        struct.pack_into('<Q', data, 24, 99999)
        variants.append(data)
        for data in variants:
            with self.subTest(data=bytes(data[:32])):
                self.write('usr/lib/broken.node', data, 0o644)
                with self.assertRaises(ValueError):
                    self.scan()

    def test_empty_input_and_linked_root_rejected(self):
        empty = Path(self.temporary.name) / 'empty'
        empty.mkdir()
        with self.assertRaises(ValueError):
            MODULE.inventory(empty, 'arm64', required=())
        link = Path(self.temporary.name) / 'linked'
        os.symlink(self.root, link)
        with self.assertRaisesRegex(ValueError, 'real directory'):
            MODULE.inventory(link, 'arm64')

    def test_cli_positive_and_negative_report_outside_input(self):
        report = Path(self.temporary.name) / 'report.json'
        command = [sys.executable, str(SCRIPT), str(self.root), str(report), '--abi', 'arm64']
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(report.read_text())['phase'], 'inventory-only')
        command[3] = str(self.root / 'report.json')
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('outside snapshot root', result.stderr)
        self.assertFalse((self.root / 'report.json').exists())

    def test_apk_inventory_accepts_snapshot_only_apk_and_rejects_wrong_abi(self):
        apk = Path(self.temporary.name) / 'test.apk'
        for member, payload, error in [
            ('lib/arm64-v8a/libproot.so', elf(), None),
            ('lib/arm64-v8a/libproot.so', elf(machine=62), 'wrong ABI'),
            ('lib/x86_64/libproot.so', elf(machine=62), 'unexpected APK native'),
            ('assets/unused', b'data', None),
        ]:
            with zipfile.ZipFile(apk, 'w') as archive:
                archive.writestr(member, payload)
                archive.writestr('assets/snapshot.tar.xz', b'snapshot fixture')
            if error:
                with self.assertRaisesRegex(ValueError, error):
                    MODULE.apk_inventory(apk, 'arm64')
            else:
                result = MODULE.apk_inventory(apk, 'arm64')
                if member.startswith('lib/'):
                    self.assertEqual(result['apkNativePayloads'][0]['path'], member)
                else:
                    self.assertEqual(result['apkNativePayloads'], [])
                self.assertEqual(len(result['snapshotArchiveSha256']), 64)


if __name__ == '__main__':
    unittest.main()
