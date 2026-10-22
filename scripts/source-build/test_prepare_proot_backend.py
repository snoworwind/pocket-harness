import hashlib
import gzip
import importlib.util
import json
import os
import pathlib
import shutil
import struct
import subprocess
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("prepare-proot-backend.py")
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
        self.inputs_path = SCRIPT.with_name("linux-inputs.json")
        self.provenance = {"repository": "https://packages.termux.dev/apt/termux-main", "index": {"sha256": "a" * 64}, "packages": []}
        self.package_roots = {}
        self.package_files = {}
        self.make_package("proot", "5.1.107.98", {
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
            "share/doc/libtalloc/copyright": b"talloc LGPL notice\n",
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
            if relative.endswith("libtalloc.so.2"):
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
        packages_text = "\n\n".join(
            "\n".join([
                f"Package: {name}",
                f"Version: {item['version']}",
                f"Architecture: {item['architecture']}",
                f"Source: {item['source']}",
                f"Filename: {item['filename']}",
                f"SHA256: {item['sha256']}",
                "Description: signed test fixture",
            ])
            for name, item in sorted((item["package"], item) for item in self.provenance["packages"])
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
        self.assertEqual(result["targetVersion"], "5.1.107.98")
        self.assertTrue(result["patchedTallocNeeded"])
        self.assertEqual({item["name"] for item in result["nativeLibraries"]}, {
            "libpocketharness_proot.so", "libpocketharness_proot_loader.so", "libtalloc.so", "libandroid-shmem.so",
        })
        self.assertTrue((self.root / "backend/share/licenses/proot/copyright").is_file())
        compat_licenses = self.root / "backend/share/licenses/pocket-harness-termfold-compat"
        self.assertTrue((compat_licenses / "LICENSE").is_file())
        self.assertEqual((compat_licenses / "NOTICE.md").read_bytes(),
                         (ROOT / "vendor/linux-proot/compat/NOTICE.md").read_bytes())

    def test_signed_package_byte_mismatch_fails_closed(self):
        self.package_files["proot"].write_bytes(b"tampered package")
        with self.assertRaisesRegex(ValueError, "hash differs from authenticated provenance"):
            self.assemble()

    def test_unreviewed_package_version_fails_closed(self):
        for item in self.provenance["packages"]:
            if item["package"] == "libtalloc":
                item["version"] = "2.5.0"
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
