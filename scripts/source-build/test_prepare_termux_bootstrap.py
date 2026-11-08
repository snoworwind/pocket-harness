import json
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import call, patch

MODULE_PATH = Path(__file__).with_name("prepare-termux-bootstrap.py")
SPEC = importlib.util.spec_from_file_location("prepare_termux_bootstrap", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
HARNESS_COMMIT = MODULE.HARNESS_COMMIT
pinned_harness_source_commit = MODULE.pinned_harness_source_commit


class PinnedHarnessSourceCommitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prepare-harness-source-")
        self.root = Path(self.temp.name) / ".deploy-tmp"
        self.source = self.root / "deepseek-harness"
        self.source.mkdir(parents=True)
        self.receipt = self.root / "source-build" / "harness-vendor-lock-reconciliation.json"
        self.receipt.parent.mkdir()
        self.write_receipt(HARNESS_COMMIT)

    def tearDown(self):
        self.temp.cleanup()

    def write_receipt(self, commit):
        self.receipt.write_text(json.dumps({"harnessSourceCommit": commit}), encoding="utf-8")

    def test_cached_materialization_uses_the_pinned_receipt_without_parent_git_lookup(self):
        self.assertFalse((self.source / ".git").exists())
        self.assertEqual(pinned_harness_source_commit(self.source), HARNESS_COMMIT)

    def test_missing_or_wrong_receipt_fails_closed(self):
        self.receipt.unlink()
        with self.assertRaisesRegex(ValueError, "receipt is missing"):
            pinned_harness_source_commit(self.source)
        self.write_receipt("a" * 40)
        with self.assertRaisesRegex(ValueError, "does not match"):
            pinned_harness_source_commit(self.source)

    def test_git_checkout_must_match_the_pinned_receipt(self):
        run = lambda *args: subprocess.run(
            ["git", *args], cwd=self.source, check=True, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        run("init", "--quiet")
        run("config", "user.name", "Fixture")
        run("config", "user.email", "fixture@example.invalid")
        (self.source / "source.txt").write_text("fixture\n", encoding="utf-8")
        run("add", "source.txt")
        run("commit", "--quiet", "-m", "fixture")
        with self.assertRaisesRegex(ValueError, "differs from its verified commit receipt"):
            pinned_harness_source_commit(self.source)

    def test_symlink_receipt_is_rejected(self):
        target = self.receipt.with_suffix(".target")
        target.write_text(json.dumps({"harnessSourceCommit": HARNESS_COMMIT}), encoding="utf-8")
        self.receipt.unlink()
        self.receipt.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "not a regular file"):
            pinned_harness_source_commit(self.source)

    def test_bootstrap_pins_are_architecture_specific_and_x86_matches_official_asset(self):
        arm64 = MODULE.bootstrap_pin("arm64")
        x86_64 = MODULE.bootstrap_pin("x86_64")
        self.assertEqual(arm64["termuxArchitecture"], "aarch64")
        self.assertEqual(x86_64["termuxArchitecture"], "x86_64")
        self.assertEqual(x86_64["sha256"], "2d23d45c1a9e72dda2172895c218334473a2d1560e724f4b88323e56e80736ff")
        self.assertTrue(x86_64["url"].endswith("/bootstrap-x86_64.zip"))
        with self.assertRaisesRegex(ValueError, "unsupported Termux bootstrap ABI"):
            MODULE.bootstrap_pin("x86")


class SeedProfileCommandTests(unittest.TestCase):
    def test_self_test_runs_before_production_profile_seed(self):
        with tempfile.TemporaryDirectory(prefix="seed-profile-command-") as temporary:
            source = Path(temporary) / "deepseek-harness"
            stage = Path(temporary) / "stage"
            source.mkdir()
            helper = Path(__file__).with_name("seed-dsh-profiles.mjs").resolve()
            with patch.object(MODULE.subprocess, "run") as run:
                MODULE.seed_profiles(source, stage)
            home = stage / "home" / ".dsh"
            self.assertEqual(run.call_args_list, [
                call(
                    ["pnpm", "exec", "tsx", str(helper), "--self-test", str(source.resolve())],
                    cwd=source,
                    check=True,
                ),
                call(
                    ["pnpm", "exec", "tsx", str(helper), str(source.resolve()), str(home.resolve())],
                    cwd=source,
                    check=True,
                ),
            ])


if __name__ == "__main__":
    unittest.main()
