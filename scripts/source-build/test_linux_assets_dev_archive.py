import re
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
        removal = re.search(r'find "\$ROOTFS/dev" -mindepth 1 -maxdepth 1 ! -type d ! -type l -exec rm -f \{\} \+', self.script)
        self.assertIsNotNone(removal, 'device-node removal must run before tar')
        self.assertLess(removal.start(), self.script.index('sudo tar '))

    def test_prepare_rootfs_still_creates_the_aliases(self):
        prepare = BUILD.with_name('..').with_name('..').resolve() / 'vendor/linux-proot/scripts/prepare-rootfs.sh'
        prepare = Path(__file__).resolve().parents[2] / 'vendor/linux-proot/scripts/prepare-rootfs.sh'
        text = prepare.read_text()
        for name, target in [('fd', '/proc/self/fd'), ('stdin', '/proc/self/fd/0'),
                             ('stdout', '/proc/self/fd/1'), ('stderr', '/proc/self/fd/2')]:
            self.assertIn(f'{name}) destination={target} ;;', text)


if __name__ == '__main__':
    unittest.main()
