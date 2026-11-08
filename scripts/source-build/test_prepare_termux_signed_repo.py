import importlib.util
import hashlib
import io
import json
import pathlib
import shutil
import ssl
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError


SCRIPT = pathlib.Path(__file__).with_name("prepare-termux-signed-repo.py")
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location("prepare_termux_signed_repo", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RetryableTermuxFetchTest(unittest.TestCase):
    @staticmethod
    def http_error(code):
        return HTTPError("https://packages.termux.dev/test", code, "temporary test response", {}, io.BytesIO())

    def test_gateway_timeout_retries_and_returns_fetched_bytes(self):
        with patch.object(module.urllib.request, "urlopen", side_effect=[self.http_error(504), io.BytesIO(b"verified bytes")]) as urlopen, \
             patch.object(module.time, "sleep") as sleep:
            self.assertEqual(module.fetch("https://packages.termux.dev/test"), b"verified bytes")
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_connection_reset_retries_before_the_next_fetch(self):
        with patch.object(module.urllib.request, "urlopen", side_effect=[URLError(ConnectionResetError("connection reset")), io.BytesIO(b"verified bytes")]) as urlopen, \
             patch.object(module.time, "sleep") as sleep:
            self.assertEqual(module.fetch("https://packages.termux.dev/test"), b"verified bytes")
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_permanent_http_error_fails_without_retry(self):
        with patch.object(module.urllib.request, "urlopen", side_effect=self.http_error(404)) as urlopen, \
             patch.object(module.time, "sleep") as sleep:
            with self.assertRaises(HTTPError):
                module.fetch("https://packages.termux.dev/missing")
        urlopen.assert_called_once()
        sleep.assert_not_called()

    def test_certificate_verification_error_fails_without_retry(self):
        failures = (
            URLError(ssl.SSLCertVerificationError("certificate verify failed")),
            ssl.SSLCertVerificationError("certificate verify failed"),
        )
        for failure in failures:
            with self.subTest(wrapped=isinstance(failure, URLError)):
                with patch.object(module.urllib.request, "urlopen", side_effect=failure) as urlopen, \
                     patch.object(module.time, "sleep") as sleep:
                    with self.assertRaises(type(failure)):
                        module.fetch("https://packages.termux.dev/untrusted")
                urlopen.assert_called_once()
                sleep.assert_not_called()

    def test_non_network_oserror_fails_without_retry(self):
        failure = PermissionError("permission denied")
        with patch.object(module.urllib.request, "urlopen", side_effect=failure) as urlopen, \
             patch.object(module.time, "sleep") as sleep:
            with self.assertRaises(PermissionError):
                module.fetch("https://packages.termux.dev/test")
        urlopen.assert_called_once()
        sleep.assert_not_called()

    def test_permanent_url_error_fails_without_retry(self):
        with patch.object(module.urllib.request, "urlopen", side_effect=URLError("unknown url type")) as urlopen, \
             patch.object(module.time, "sleep") as sleep:
            with self.assertRaises(URLError):
                module.fetch("https://packages.termux.dev/test")
        urlopen.assert_called_once()
        sleep.assert_not_called()

    def test_gateway_timeouts_stop_at_the_configured_attempt_limit(self):
        with patch.object(module.urllib.request, "urlopen", side_effect=self.http_error(504)) as urlopen, \
             patch.object(module.time, "sleep") as sleep:
            with self.assertRaises(HTTPError):
                module.fetch("https://packages.termux.dev/unavailable")
        self.assertEqual(urlopen.call_count, module.FETCH_ATTEMPTS)
        self.assertEqual(sleep.call_count, module.FETCH_ATTEMPTS - 1)
        self.assertLessEqual(max(call.args[0] for call in sleep.call_args_list), module.FETCH_RETRY_MAX_DELAY_SECONDS)


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

    def test_x86_64_architecture_aliases_select_native_packages_and_dependencies(self):
        selected = module.select_package_records([
            {"Package": "nodejs-lts", "Version": "24.1", "Architecture": "aarch64"},
            {"Package": "nodejs-lts", "Version": "24.1", "Architecture": "x86_64"},
            {"Package": "ca-certificates", "Version": "1", "Architecture": "all"},
        ], "x86_64")
        self.assertEqual(selected["nodejs-lts"]["Architecture"], "x86_64")
        records = {
            "root": {"Package": "root", "Version": "1", "Architecture": "x86_64",
                     "Depends": "libc [amd64] | libc-arm [arm64], ca-certificates:any"},
            "libc": {"Package": "libc", "Version": "1", "Architecture": "x86_64"},
            "libc-arm": {"Package": "libc-arm", "Version": "1", "Architecture": "aarch64"},
            "ca-certificates": {"Package": "ca-certificates", "Version": "1", "Architecture": "all",
                                 "Multi-Arch": "foreign"},
        }
        self.assertEqual(module.dependency_closure(records, ["root"], "x86 test", "x86_64"),
                         {"root", "libc", "ca-certificates"})

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
    def test_x86_64_index_selects_x86_64_and_all_but_not_aarch64(self):
        records = module.select_package_records([
            {"Package": "nodejs-lts", "Version": "24.1", "Architecture": "aarch64", "Filename": "arm.deb"},
            {"Package": "nodejs-lts", "Version": "24.1", "Architecture": "x86_64", "Filename": "x64.deb"},
            {"Package": "ca-certificates", "Version": "1", "Architecture": "all", "Filename": "all.deb"},
        ], "x86_64")
        self.assertEqual(records["nodejs-lts"]["Filename"], "x64.deb")
        self.assertEqual(records["ca-certificates"]["Filename"], "all.deb")

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


class ReproducibleTermuxInputsTest(unittest.TestCase):
    def test_rolling_inrelease_digest_is_run_provenance_not_a_static_lock(self):
        root = pathlib.Path(__file__).parent
        inputs = json.loads((root / "linux-inputs.json").read_text(encoding="utf-8"))
        self.assertNotIn("termuxInReleaseSha256", inputs)
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn('inrelease_hash = hashlib.sha256(inrelease).hexdigest()', source)
        self.assertIn('"inRelease": {"path": "dists/stable/InRelease", "sha256": inrelease_hash}', source)

    def test_package_recipes_use_the_pinned_immutable_termux_commit(self):
        root = pathlib.Path(__file__).parent
        inputs = json.loads((root / "linux-inputs.json").read_text(encoding="utf-8"))
        backend = json.loads((root / "linux-backend-packages.json").read_text(encoding="utf-8"))
        manifest = json.loads((root / "linux-source-manifest.json").read_text(encoding="utf-8"))
        commit = inputs.get("termuxPackagesRecipeCommit")
        self.assertRegex(commit or "", r"^[0-9a-f]{40}$")
        self.assertNotIn("termuxInReleaseSha256", inputs)
        external = next(item for item in manifest["externalSources"]
                        if item["component"] == "Termux PRoot ARM64 package closure")
        self.assertEqual(external.get("recipeCommit"), commit)
        for name, source in backend["packageSources"].items():
            with self.subTest(package=name):
                self.assertEqual(source.get("recipeCommit"), commit)
                self.assertRegex(source.get("recipeSha256", ""), r"^[0-9a-f]{64}$")
                self.assertRegex(source.get("recipePath", ""), r"^packages/[a-z0-9-]+/build\.sh$")
                raw_url = module.termux_recipe_url(source, commit)
                self.assertIn(f"/termux-packages/{commit}/", raw_url)

    def test_recipe_bytes_must_match_the_pinned_sha256(self):
        payload = b"TERMUX_PKG_VERSION=1.0\n"
        digest = hashlib.sha256(payload).hexdigest()
        commit = "a" * 40
        source = {
            "recipePath": "packages/example/build.sh",
            "recipe": f"https://github.com/termux/termux-packages/blob/{commit}/packages/example/build.sh",
            "recipeCommit": commit,
            "recipeSha256": digest,
        }
        self.assertEqual(module.verify_termux_recipe(source, commit, payload), digest)
        with self.assertRaisesRegex(ValueError, "recipe digest mismatch"):
            module.verify_termux_recipe(source, commit, b"TERMUX_PKG_VERSION=1.1\n")
        with self.assertRaisesRegex(ValueError, "immutable URL"):
            module.termux_recipe_url({**source, "recipe": source["recipe"].replace(commit, "master")}, commit)
        unsafe = {**source, "recipePath": "packages/example/../../outside.sh"}
        unsafe["recipe"] = f"https://github.com/termux/termux-packages/blob/{commit}/{unsafe['recipePath']}"
        with self.assertRaisesRegex(ValueError, "recipe path is missing"):
            module.termux_recipe_url(unsafe, commit)


if __name__ == "__main__":
    unittest.main()
