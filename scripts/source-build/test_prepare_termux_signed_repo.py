import importlib.util
import pathlib
import shutil
import sys
import unittest


SCRIPT = pathlib.Path(__file__).with_name("prepare-termux-signed-repo.py")
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location("prepare_termux_signed_repo", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SignedTermuxRepoParserTest(unittest.TestCase):
    def test_duplicate_control_fields_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate field"):
            list(module.parse_stanzas("Package: proot\nVersion: 1\nVersion: 2\n"))

    def test_foreign_architecture_alternative_is_skipped(self):
        records = {
            "target": {"Package": "target", "Version": "1", "Architecture": "aarch64"},
            "foreign": {"Package": "foreign", "Version": "1", "Architecture": "aarch64"},
        }
        self.assertIsNone(module._dependency_applies("foreign [amd64]", "root", records))
        self.assertIsNone(module._dependency_applies("target [!arm64]", "root", records))
        self.assertEqual(module._dependency_applies("target [!amd64]", "root", records), "target")
        self.assertEqual(module._dependency_applies("target [linux-any]", "root", records), "target")

    def test_debian_epoch_is_allowed_only_in_package_filename(self):
        path = module.safe_termux_package_filename(
            "pool/main/c/ca-certificates/ca-certificates_1:2026.10.20-1_all.deb"
        )
        self.assertEqual(path.parts[-1], "ca-certificates_1:2026.10.20-1_all.deb")

    def test_unsafe_signed_package_paths_and_url_metacharacters_are_rejected(self):
        unsafe_paths = [
            "../outside.deb",
            "/pool/main/a/pkg/pkg_1_aarch64.deb",
            "pool/main/a/pkg/../../outside.deb",
            "pool/main/a/pkg:escape/pkg_1_aarch64.deb",
            "pool/main/a/pkg/pkg_1_aarch64.deb?mirror=evil",
            "pool/main/a/pkg/pkg_1_aarch64.deb#fragment",
            "pool/main/a/pkg/pkg_1_aarch64.rpm",
        ]
        for filename in unsafe_paths:
            with self.subTest(filename=filename):
                with self.assertRaisesRegex(ValueError, "unsafe Termux package filename"):
                    module.safe_termux_package_filename(filename)

    @unittest.skipUnless(shutil.which("dpkg"), "package candidate selection requires dpkg; Linux CI provides it")
    def test_signed_index_selects_newest_debian_version_and_native_tie(self):
        records = module.select_package_records([
            {"Package": "buf", "Version": "1.74.0-1", "Architecture": "aarch64", "Filename": "old.deb"},
            {"Package": "buf", "Version": "1.75.0", "Architecture": "aarch64", "Filename": "new.deb"},
            {"Package": "tie", "Version": "2.0", "Architecture": "all", "Filename": "all.deb"},
            {"Package": "tie", "Version": "2.0", "Architecture": "aarch64", "Filename": "native.deb"},
            {"Package": "foreign", "Version": "9.0", "Architecture": "amd64", "Filename": "foreign.deb"},
        ])
        self.assertEqual(records["buf"]["Filename"], "new.deb")
        self.assertEqual(records["tie"]["Filename"], "native.deb")
        self.assertNotIn("foreign", records)

    @unittest.skipUnless(shutil.which("dpkg"), "package candidate selection requires dpkg; Linux CI provides it")
    def test_same_version_and_architecture_duplicates_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "duplicate signed Termux package candidate: buf=1.75.0"):
            module.select_package_records([
                {"Package": "buf", "Version": "1.75.0", "Architecture": "aarch64", "Filename": "one.deb"},
                {"Package": "buf", "Version": "1.75.0", "Architecture": "aarch64", "Filename": "two.deb"},
            ])

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
