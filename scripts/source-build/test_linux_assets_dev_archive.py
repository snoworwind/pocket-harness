import re
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

BUILD = Path(__file__).with_name('build-linux-assets.sh')


class LinuxAssetsDevArchiveTest(unittest.TestCase):
    """The shipped rootfs must keep the standard /dev aliases and must not ship device nodes."""

    def setUp(self):
        self.script = BUILD.read_text()

    def tar_command(self):
        match = re.search(r'sudo tar [^\n]*\n', self.script)
        self.assertIsNotNone(match, 'rootfs archive command not found')
        return match.group(0)

    def test_archive_keeps_dev_symlinks(self):
        command = self.tar_command()
        self.assertNotIn("--exclude='./dev/*'", command)
        self.assertNotIn('--exclude=./dev/*', command)
        self.assertIn("--exclude='./dev/pts/*'", command)
        self.assertIn("--exclude='./dev/shm/*'", command)

    def test_device_nodes_are_removed_before_archiving(self):
        command = 'sudo find "$ROOTFS/dev" -xdev -mindepth 1 ! -type d ! -type l -delete'
        self.assertIn(command, self.script)
        self.assertLess(self.script.index(command), self.script.index('sudo tar '))

    def test_cleanup_removes_regular_files_and_fifos_but_keeps_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dev = root / 'dev'
            dev.mkdir()
            (dev / 'pts').mkdir()
            (dev / 'fd').symlink_to('/proc/self/fd')
            (dev / 'accidental').write_text('not a device')
            os.mkfifo(dev / 'initctl')
            command = next(line for line in self.script.splitlines() if line.startswith('sudo find "$ROOTFS/dev"'))
            subprocess.run(['sh', '-c', command.removeprefix('sudo ')], env={**os.environ, 'ROOTFS': str(root)}, check=True)
            self.assertEqual({p.name for p in dev.iterdir()}, {'pts', 'fd'})

    def test_prepare_rootfs_still_creates_the_aliases(self):
        prepare = BUILD.with_name('..').with_name('..').resolve() / 'vendor/linux-proot/scripts/prepare-rootfs.sh'
        prepare = Path(__file__).resolve().parents[2] / 'vendor/linux-proot/scripts/prepare-rootfs.sh'
        text = prepare.read_text()
        for name, target in [('fd', '/proc/self/fd'), ('stdin', '/proc/self/fd/0'),
                             ('stdout', '/proc/self/fd/1'), ('stderr', '/proc/self/fd/2')]:
            self.assertIn(f'{name}) destination={target} ;;', text)


if __name__ == '__main__':
    unittest.main()
