import hashlib
import gzip
import importlib.util
import json
import os
import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("prepare-proot-backend.py")
sys.path.insert(0, str(SCRIPT.parent))
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("prepare_proot_backend", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def elf64(elf_type, needed=(), interpreter=None):
    phoff = 64
    phentsize = 56
    phnum = 2 + (1 if interpreter else 0)
    dynamic_offset = phoff + phentsize * phnum
    needed_names = [name.encode() + b"\0" for name in needed]
    string_table = b"".join(needed_names)
    string_offsets = []
    cursor = 0
    for name in needed_names:
        string_offsets.append(cursor)
        cursor += len(name)
    string_offset = dynamic_offset + 16 * (len(needed) + 3)
    dynamic = b"".join(struct.pack("<qQ", 1, offset) for offset in string_offsets)
    dynamic += struct.pack("<qQ", 5, string_offset)
    dynamic += struct.pack("<qQ", 10, len(string_table))
    dynamic += struct.pack("<qQ", 0, 0)
    interp_bytes = interpreter.encode() + b"\0" if interpreter else b""
    interp_offset = string_offset + len(string_table)
    total_size = interp_offset + len(interp_bytes)
    data = bytearray(total_size)
    data[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<H", data, 16, elf_type)
    struct.pack_into("<H", data, 18, 183)
    struct.pack_into("<Q", data, 24, 0x100 if elf_type == 2 else 0)
    struct.pack_into("<Q", data, 32, phoff)
    struct.pack_into("<H", data, 54, phentsize)
    struct.pack_into("<H", data, 56, phnum)
    # PT_LOAD maps the complete file at virtual address zero.
    struct.pack_into("<IIQQQQQQ", data, phoff, 1, 5, 0, 0, 0, total_size, total_size, 0x1000)
    struct.pack_into("<IIQQQQQQ", data, phoff + phentsize, 2, 4, dynamic_offset, 0, 0,
                     len(dynamic), len(dynamic), 8)
    if interpreter:
        struct.pack_into("<IIQQQQQQ", data, phoff + 2 * phentsize, 3, 4, interp_offset, 0, 0,
                         len(interp_bytes), len(interp_bytes), 1)
    data[dynamic_offset:dynamic_offset + len(dynamic)] = dynamic
    data[string_offset:string_offset + len(string_table)] = string_table
    if interpreter:
        data[interp_offset:interp_offset + len(interp_bytes)] = interp_bytes
    return bytes(data)


class SafeTermuxPackagePathTest(unittest.TestCase):
    def test_epoch_package_filename_resolves_within_webroot(self):
        with tempfile.TemporaryDirectory(prefix="termux-epoch-path-") as temporary:
            webroot = pathlib.Path(temporary)
            relative = pathlib.Path("pool/main/c/ca-certificates/ca-certificates_1:2026.10.20-1_all.deb")
            package = webroot / relative
            package.parent.mkdir(parents=True)
            package.write_bytes(b"signed package fixture")
            self.assertEqual(module.safe_package_file(webroot, relative.as_posix()), package.resolve())

    def test_package_paths_still_reject_traversal_and_url_metacharacters(self):
        with tempfile.TemporaryDirectory(prefix="termux-unsafe-path-") as temporary:
            webroot = pathlib.Path(temporary)
            for filename in ("../outside.deb", "pool/main/pkg:escape/pkg_1.deb",
                             "pool/main/p/pkg/p_1.deb?mirror=evil", "pool/main/p/pkg/p_1.deb#fragment"):
                with self.subTest(filename=filename):
                    with self.assertRaisesRegex(ValueError, "unsafe Termux package filename"):
                        module.safe_package_file(webroot, filename)


class SafeTermuxCopyrightTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="termux-copyright-")
        self.root = pathlib.Path(self.temp.name)
        self.prefix = self.root / "package/usr"
        (self.prefix / "share/doc/libtalloc").mkdir(parents=True)
        self.shared = self.root / "bootstrap/usr/share/LICENSES"
        self.shared.mkdir(parents=True)
        (self.shared / "LGPL-3.0.txt").write_text("authenticated generic license\n")

    def tearDown(self):
        self.temp.cleanup()

    def test_resolves_only_termux_shared_license_link(self):
        (self.prefix / "share/doc/libtalloc/copyright").symlink_to("../../LICENSES/LGPL-3.0.txt")
        destination = self.root / "backend/share/licenses"
        origin = module.copy_copyright(self.prefix, "libtalloc", destination, self.shared)
        self.assertEqual((destination / "libtalloc/copyright").read_text(), "authenticated generic license\n")
        self.assertEqual(origin["source"], "official-termux-bootstrap:share/LICENSES/LGPL-3.0.txt")

    def test_rejects_copyright_link_outside_package_and_shared_license_roots(self):
        (self.prefix / "share/doc/libtalloc/copyright").symlink_to("/etc/passwd")
        with self.assertRaisesRegex(ValueError, "escapes its authenticated roots"):
            module.copy_copyright(self.prefix, "libtalloc", self.root / "backend/share/licenses", self.shared)

    def test_rejects_missing_non_shared_copyright_target(self):
        (self.prefix / "share/doc/libtalloc/copyright").symlink_to("../../doc/missing.txt")
        with self.assertRaisesRegex(ValueError, "missing non-shared target"):
            module.copy_copyright(self.prefix, "libtalloc", self.root / "backend/share/licenses", self.shared)

    def test_rejects_missing_file_from_official_shared_license_root(self):
        (self.prefix / "share/doc/libtalloc/copyright").symlink_to("../../LICENSES/UNKNOWN.txt")
        with self.assertRaisesRegex(ValueError, "official Termux bootstrap omitted shared license"):
            module.copy_copyright(self.prefix, "libtalloc", self.root / "backend/share/licenses", self.shared)

    def test_bootstrap_shared_license_directory_cannot_be_a_symlink(self):
        (self.shared / "LGPL-3.0.txt").unlink()
        self.shared.rmdir()
        outside = self.root / "untrusted-license-directory"
        outside.mkdir()
        self.shared.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "omitted its shared license directory"):
            module.termux_shared_license_root(self.root / "bootstrap/usr")


@unittest.skipUnless(shutil.which("dpkg-deb") and shutil.which("gpg") and shutil.which("gpgv"),
                     "backend assembly integration requires dpkg-deb and GnuPG")
class PrepareProotBackendTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prepare-proot-backend-")
        self.root = pathlib.Path(self.temp.name)
        self.webroot = self.root / "webroot"
        self.webroot.mkdir()
        self.provenance_path = self.root / "termux-packages-provenance.json"
        self.bootstrap_usr = self.root / "bootstrap-usr"
        (self.bootstrap_usr / "share/termux-keyring").mkdir(parents=True)
        (self.bootstrap_usr / "share/LICENSES").mkdir(parents=True)
        (self.bootstrap_usr / "share/LICENSES/LGPL-3.0.txt").write_text("authenticated generic license\n")
        self.inputs_path = SCRIPT.with_name("linux-inputs.json")
        self.provenance = {"repository": "https://packages.termux.dev/apt/termux-main", "index": {"sha256": "a" * 64}, "packages": []}
        self.package_roots = {}
        self.package_files = {}
        self.make_package("proot", "5.1.107.101", {
            "bin/proot": elf64(3, ["libtalloc.so.2", "libandroid-shmem.so"], "/system/bin/linker64"),
            "libexec/proot/loader": elf64(2),
            "share/doc/proot/copyright": b"PRoot GPL notice\n",
        })
        self.make_package("libandroid-shmem", "0.7", {
            "lib/libandroid-shmem.so": elf64(3),
            "share/doc/libandroid-shmem/copyright": b"shmem BSD notice\n",
        })
        self.make_package("libtalloc", "2.5.0", {
            "lib/libtalloc.so.2.5.0": elf64(3),
            "lib/libtalloc.so.2": b"libtalloc.so.2.5.0\0",
            "share/doc/libtalloc/copyright": ("symlink", "../../LICENSES/LGPL-3.0.txt"),
        })
        self.make_signed_repo()

    def tearDown(self):
        self.temp.cleanup()

    def make_package(self, name, version, files):
        package_root = self.root / (name + "-package")
        prefix = package_root / "data/data/com.termux/files/usr"
        prefix.mkdir(parents=True)
        control = package_root / "DEBIAN/control"
        control.parent.mkdir(parents=True)
        control.write_text(f"Package: {name}\nVersion: {version}\nArchitecture: aarch64\nDescription: fixture\n")
        for relative, payload in files.items():
            target = prefix / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(payload, tuple) and payload[0] == "symlink":
                target.symlink_to(payload[1])
            elif relative.endswith("libtalloc.so.2"):
                target.symlink_to(payload.decode().strip("\0"))
            else:
                target.write_bytes(payload)
                if relative.startswith("bin/") or relative.endswith("loader"):
                    target.chmod(0o755)
        package_relative = pathlib.Path("pool/main") / name / (name + ".deb")
        package_file = self.webroot / package_relative
        package_file.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["dpkg-deb", "--build", str(package_root), str(package_file)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        digest = hashlib.sha256(package_file.read_bytes()).hexdigest()
        self.provenance["packages"].append({
            "package": name, "version": version, "architecture": "aarch64", "source": name,
            "filename": package_relative.as_posix(), "sha256": digest, "purposes": ["linux-backend"],
        })
        self.package_files[name] = package_file

    def make_signed_repo(self):
        index_records = [
            {
                "Package": item["package"], "Version": item["version"],
                "Architecture": item["architecture"], "Source": item["source"],
                "Filename": item["filename"], "SHA256": item["sha256"],
            }
            for item in self.provenance["packages"]
        ]
        index_records.extend([
            {"Package": "buf", "Version": "1.74.0-1", "Architecture": "aarch64",
             "Source": "buf", "Filename": "pool/main/b/buf/buf_1.74.0-1_aarch64.deb", "SHA256": "a" * 64},
            {"Package": "buf", "Version": "1.75.0", "Architecture": "aarch64",
             "Source": "buf", "Filename": "pool/main/b/buf/buf_1.75.0_aarch64.deb", "SHA256": "b" * 64},
            {"Package": "proot", "Version": "5.1.100.1", "Architecture": "aarch64",
             "Source": "proot", "Filename": "pool/main/p/proot/proot_5.1.100.1_aarch64.deb", "SHA256": "c" * 64},
        ])
        packages_text = "\n\n".join(
            "\n".join([*(f"{key}: {value}" for key, value in record.items()),
                      "Description: signed test fixture"])
            for record in sorted(index_records, key=lambda item: (item["Package"], item["Version"]))
        ) + "\n"
        index_path = self.webroot / "dists/stable/main/binary-aarch64/Packages.gz"
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_bytes = gzip.compress(packages_text.encode(), mtime=0)
        index_path.write_bytes(index_bytes)
        release_text = (
            "Origin: test fixture\nLabel: test fixture\nSuite: stable\nCodename: stable\n"
            "Architectures: aarch64\nComponents: main\nSHA256:\n"
            f" {hashlib.sha256(index_bytes).hexdigest()} {len(index_bytes)} main/binary-aarch64/Packages.gz\n"
        )
        release = self.root / "Release"
        release.write_text(release_text)
        home = self.root / "gpg-home"
        home.mkdir()
        home.chmod(0o700)
        subprocess.run(["gpg", "--homedir", str(home), "--batch", "--passphrase", "", "--quick-generate-key",
                        "Pocket Harness test fixture <test@example.invalid>", "rsa2048", "sign", "1d"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        inrelease_path = self.webroot / "dists/stable/InRelease"
        inrelease_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["gpg", "--homedir", str(home), "--batch", "--yes", "--clearsign", "--output",
                        str(inrelease_path), str(release)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with (self.bootstrap_usr / "share/termux-keyring/test.gpg").open("wb") as output:
            subprocess.run(["gpg", "--homedir", str(home), "--batch", "--export"], check=True, stdout=output)
        self.provenance["suite"] = "stable"
        self.provenance["inRelease"] = {
            "path": "dists/stable/InRelease", "sha256": hashlib.sha256(inrelease_path.read_bytes()).hexdigest(),
        }
        self.provenance["index"] = {
            "path": "dists/stable/main/binary-aarch64/Packages.gz",
            "sha256": hashlib.sha256(index_bytes).hexdigest(),
            "signedReleaseSha256": self.provenance["inRelease"]["sha256"],
        }
        self.write_provenance()

    def write_provenance(self):
        self.provenance["packageCount"] = len(self.provenance["packages"])
        self.provenance_path.write_text(json.dumps(self.provenance))

    def assemble(self):
        backend = self.root / "backend"
        native = self.root / "native-libs"
        return module.assemble(str(self.webroot), str(self.provenance_path), str(self.inputs_path), str(self.bootstrap_usr),
                              str(backend), str(native))

    def test_assembles_signed_closure_and_shortens_only_the_reviewed_needed_entry(self):
        result = self.assemble()
        proot = (self.root / "backend/bin/proot").read_bytes()
        self.assertIn(b"libtalloc.so\0", proot)
        self.assertNotIn(b"libtalloc.so.2\0", proot)
        self.assertEqual(result["targetVersion"], "5.1.107.101")
        self.assertTrue(result["patchedTallocNeeded"])
        self.assertEqual({item["name"] for item in result["nativeLibraries"]}, {
            "libpocketharness_proot.so", "libpocketharness_proot_loader.so", "libtalloc.so", "libandroid-shmem.so",
        })
        self.assertTrue((self.root / "backend/share/licenses/proot/copyright").is_file())
        self.assertEqual((self.root / "backend/share/licenses/libtalloc/copyright").read_text(),
                         "authenticated generic license\n")
        license_origins = {item["package"]: item["source"] for item in result["licenseOrigins"]}
        self.assertEqual(license_origins["libtalloc"],
                         "official-termux-bootstrap:share/LICENSES/LGPL-3.0.txt")
        compat_licenses = self.root / "backend/share/licenses/pocket-harness-termfold-compat"
        self.assertTrue((compat_licenses / "LICENSE").is_file())
        self.assertEqual((compat_licenses / "NOTICE.md").read_bytes(),
                         (ROOT / "vendor/linux-proot/compat/NOTICE.md").read_bytes())

    def test_authenticated_index_selects_newest_signed_record_per_package(self):
        records = module.authenticated_package_index(self.webroot, self.provenance, self.bootstrap_usr)
        self.assertEqual(records["buf"]["Version"], "1.75.0")
        self.assertEqual(records["proot"]["Version"], "5.1.107.101")

    def test_provenance_cannot_select_an_older_signed_candidate(self):
        proot = next(item for item in self.provenance["packages"] if item["package"] == "proot")
        proot["version"] = "5.1.100.1"
        proot["filename"] = "pool/main/p/proot/proot_5.1.100.1_aarch64.deb"
        proot["sha256"] = "c" * 64
        self.write_provenance()
        with self.assertRaisesRegex(ValueError, "provenance differs from signed index: proot version"):
            self.assemble()

    def test_signed_package_byte_mismatch_fails_closed(self):
        self.package_files["proot"].write_bytes(b"tampered package")
        with self.assertRaisesRegex(ValueError, "hash differs from authenticated provenance"):
            self.assemble()

    def test_unreviewed_package_version_fails_closed(self):
        for item in self.provenance["packages"]:
            if item["package"] == "libtalloc":
                item["version"] = "2.5.1"
        self.write_provenance()
        with self.assertRaisesRegex(ValueError, "provenance differs from signed index: libtalloc version"):
            self.assemble()

    def test_forged_provenance_cannot_replace_the_signed_package_index(self):
        item = next(item for item in self.provenance["packages"] if item["package"] == "proot")
        item["sha256"] = "0" * 64
        self.write_provenance()
        with self.assertRaisesRegex(ValueError, "provenance differs from signed index: proot sha256"):
            self.assemble()

    def test_tampered_signed_index_fails_against_inrelease(self):
        index = self.webroot / "dists/stable/main/binary-aarch64/Packages.gz"
        index.write_bytes(index.read_bytes() + b"tampered")
        with self.assertRaisesRegex(ValueError, "differs from the signed Release"):
            self.assemble()

    def test_tampered_inrelease_fails_signature_verification(self):
        inrelease = self.webroot / "dists/stable/InRelease"
        inrelease.write_bytes(inrelease.read_bytes().replace(b"test fixture", b"evil fixture", 1))
        self.provenance["inRelease"]["sha256"] = hashlib.sha256(inrelease.read_bytes()).hexdigest()
        self.provenance["index"]["signedReleaseSha256"] = self.provenance["inRelease"]["sha256"]
        self.write_provenance()
        with self.assertRaises(subprocess.CalledProcessError):
            self.assemble()


if __name__ == "__main__":
    unittest.main()
