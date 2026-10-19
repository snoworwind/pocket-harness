import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('base_archive', pathlib.Path(__file__).with_name('base-archive.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BaseArchiveTest(unittest.TestCase):
    def test_relative_package_links_are_preserved(self):
        with tempfile.TemporaryDirectory() as root:
            archive = pathlib.Path(root) / 'base.tar'
            with tarfile.open(archive, 'w') as output:
                file = tarfile.TarInfo('engine-deploy/store/pkg.js')
                file.size = 2
                output.addfile(file, io.BytesIO(b'ok'))
                link = tarfile.TarInfo('engine-deploy/node_modules/pkg')
                link.type = tarfile.SYMTYPE
                link.linkname = '../store'
                output.addfile(link)
            target = pathlib.Path(root) / 'out'
            module.extract(archive, target)
            self.assertEqual((target / 'engine-deploy/node_modules/pkg/pkg.js').read_bytes(), b'ok')

    def test_traversal_links_duplicates_and_special_members_fail(self):
        for name in ['../escape', '/absolute', 'unknown/file']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                module.validate([tarfile.TarInfo(name)])
        for kind in [tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE]:
            item = tarfile.TarInfo('engine-deploy/member')
            item.type = kind
            with self.assertRaises(ValueError):
                module.validate([item])
        item = tarfile.TarInfo('engine-deploy/member')
        with self.assertRaises(ValueError):
            module.validate([item, item])
        link = tarfile.TarInfo('engine-deploy/link')
        link.type = tarfile.SYMTYPE
        for target in ['/outside', '../../outside', '../reports/other']:
            link.linkname = target
            with self.assertRaises(ValueError):
                module.validate([link])
        link.linkname = 'store'
        with self.assertRaises(ValueError):
            module.validate([link, tarfile.TarInfo('engine-deploy/link/overwrite')])


if __name__ == '__main__':
    unittest.main()
