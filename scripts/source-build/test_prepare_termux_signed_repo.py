import importlib.util
import pathlib
import shutil
import unittest


SCRIPT = pathlib.Path(__file__).with_name("prepare-termux-signed-repo.py")
spec = importlib.util.spec_from_file_location("prepare_termux_signed_repo", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SignedTermuxRepoParserTest(unittest.TestCase):
    def test_duplicate_control_fields_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate field"):
            list(module.parse_stanzas("Package: proot\nVersion: 1\nVersion: 2\n"))

    @unittest.skipUnless(shutil.which("dpkg"), "dependency version comparisons require dpkg; Linux CI provides it")
    def test_dependency_closure_honors_version_architecture_and_multiarch(self):
        records = {
            "root": {
                "Package": "root", "Version": "1", "Architecture": "aarch64",
                "Depends": "libc (>= 2) | libc-legacy, arch-native [aarch64] | arch-other [amd64], multi:any",
            },
            "libc": {"Package": "libc", "Version": "1", "Architecture": "aarch64"},
            "libc-legacy": {"Package": "libc-legacy", "Version": "3", "Architecture": "aarch64"},
            "arch-native": {"Package": "arch-native", "Version": "1", "Architecture": "all"},
            "arch-other": {"Package": "arch-other", "Version": "1", "Architecture": "aarch64"},
            "multi": {"Package": "multi", "Version": "1", "Architecture": "all", "Multi-Arch": "allowed"},
        }
        self.assertEqual(module.dependency_closure(records, ["root"], "test"),
                         {"root", "libc-legacy", "arch-native", "multi"})

    def test_unsupported_dependency_syntax_fails_closed(self):
        records = {"root": {"Package": "root", "Version": "1", "Architecture": "aarch64",
                            "Depends": "child <nocheck>"},
                   "child": {"Package": "child", "Version": "1", "Architecture": "aarch64"}}
        with self.assertRaisesRegex(ValueError, "build-profile"):
            module.dependency_closure(records, ["root"], "test")


if __name__ == "__main__":
    unittest.main()
