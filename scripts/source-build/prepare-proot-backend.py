#!/usr/bin/env python3
"""Assemble the reviewed Termux PRoot package closure from authenticated .debs."""
from __future__ import annotations

import hashlib
import gzip
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile

from termux_signed_packages import safe_termux_package_filename, select_package_records

PREFIX = PurePosixPath("data/data/com.termux/files/usr")
SHARED_OBJECT_MARKER = ".so"
TERMUX_REPOSITORY = "https://packages.termux.dev/apt/termux-main"
TERMUX_INDEX_REL = "main/binary-aarch64/Packages.gz"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_package_file(webroot: Path, filename: str) -> Path:
    relative = safe_termux_package_filename(filename)
    root = webroot.resolve(strict=True)
    package = root.joinpath(*relative.parts)
    resolved = package.resolve(strict=True)
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise ValueError(f"Termux package escapes the authenticated webroot: {filename}")
    return resolved


def parse_stanzas(text: str):
    for block in text.split("\n\n"):
        record = {}
        key = None
        for line in block.splitlines():
            if line[:1].isspace() and key:
                record[key] += "\n" + line[1:]
            elif ": " in line:
                key, value = line.split(": ", 1)
                if key in record:
                    raise ValueError(f"duplicate field in authenticated Termux package stanza: {key}")
                record[key] = value
            elif line.strip():
                raise ValueError(f"invalid line in authenticated Termux package stanza: {line!r}")
        if "Package" in record:
            yield record


def signed_sha256(release_text: str, relative_path: str) -> tuple[str, int]:
    marker = "SHA256:\n"
    if marker not in release_text:
        raise ValueError("verified Termux Release has no SHA256 section")
    section = release_text.split(marker, 1)[1]
    for line in section.splitlines():
        fields = line.split()
        if len(fields) == 3 and fields[2] == relative_path:
            if not re.fullmatch(r"[a-fA-F0-9]{64}", fields[0]) or not fields[1].isdigit():
                raise ValueError(f"verified Termux Release has an invalid SHA256 record for {relative_path}")
            return fields[0].lower(), int(fields[1])
        if not line.strip():
            break
    raise ValueError(f"verified Termux Release does not list {relative_path}")


def authenticated_package_index(webroot: Path, provenance: dict, bootstrap_usr: Path) -> dict[str, dict]:
    key_dir = bootstrap_usr / "share" / "termux-keyring"
    keys = sorted(key_dir.glob("*.gpg"))
    if not keys or key_dir.is_symlink():
        raise ValueError(f"official Termux signing keys are missing from {key_dir}")
    inrelease_rel = PurePosixPath("dists/stable/InRelease")
    inrelease_path = webroot.joinpath(*inrelease_rel.parts)
    if inrelease_path.is_symlink() or not inrelease_path.is_file():
        raise ValueError("authenticated Termux InRelease is missing or unsafe")
    inrelease_bytes = inrelease_path.read_bytes()
    inrelease_hash = hashlib.sha256(inrelease_bytes).hexdigest()
    recorded_release = provenance.get("inRelease")
    if not isinstance(recorded_release, dict) or recorded_release.get("path") != inrelease_rel.as_posix() or recorded_release.get("sha256") != inrelease_hash:
        raise ValueError("Termux InRelease differs from the retained provenance record")

    with tempfile.TemporaryDirectory(prefix="proot-termux-gpg-") as temporary:
        home = Path(temporary)
        home.chmod(0o700)
        for key in keys:
            if key.is_symlink() or not key.is_file():
                raise ValueError(f"unsafe Termux signing key: {key.name}")
            subprocess.run(["gpg", "--homedir", str(home), "--batch", "--import", str(key)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        keyring = home / "termux-keys.gpg"
        with keyring.open("wb") as output:
            subprocess.run(["gpg", "--homedir", str(home), "--batch", "--export"], check=True, stdout=output)
        inrelease = home / "InRelease"
        inrelease.write_bytes(inrelease_bytes)
        release = home / "Release"
        subprocess.run(["gpgv", "--keyring", str(keyring), "--output", str(release), str(inrelease)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        release_text = release.read_text(encoding="utf-8")

    expected_index_hash, expected_index_size = signed_sha256(release_text, TERMUX_INDEX_REL)
    index_path = webroot.joinpath("dists", "stable", *PurePosixPath(TERMUX_INDEX_REL).parts)
    if index_path.is_symlink() or not index_path.is_file():
        raise ValueError("authenticated Termux Packages.gz is missing or unsafe")
    index_bytes = index_path.read_bytes()
    index_hash = hashlib.sha256(index_bytes).hexdigest()
    if len(index_bytes) != expected_index_size or index_hash != expected_index_hash:
        raise ValueError("Termux Packages.gz differs from the signed Release file")
    recorded_index = provenance.get("index")
    if not isinstance(recorded_index, dict) or recorded_index.get("path") != f"dists/stable/{TERMUX_INDEX_REL}" \
            or recorded_index.get("sha256") != index_hash or recorded_index.get("signedReleaseSha256") != inrelease_hash:
        raise ValueError("Termux Packages.gz differs from the retained provenance record")
    try:
        text = gzip.decompress(index_bytes).decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise ValueError(f"authenticated Termux Packages.gz is invalid: {error}") from error
    return select_package_records(parse_stanzas(text))


def package_prefix(extracted: Path) -> Path:
    prefix = extracted.joinpath(*PREFIX.parts)
    if not prefix.is_dir() or prefix.is_symlink():
        raise ValueError("Termux package omitted its expected usr prefix")
    return prefix


def copy_shared_libraries(source_lib: Path, destination_lib: Path) -> None:
    if not source_lib.is_dir():
        return
    destination_lib.mkdir(parents=True, exist_ok=True)
    for source in sorted(source_lib.iterdir()):
        if SHARED_OBJECT_MARKER not in source.name:
            continue
        destination = destination_lib / source.name
        if source.is_symlink():
            target = os.readlink(source)
            if os.path.isabs(target):
                raise ValueError(f"absolute Termux library symlink is forbidden: {source.name}")
            resolved = (source.parent / target).resolve(strict=True)
            if not resolved.is_relative_to(source.parent.resolve(strict=True)):
                raise ValueError(f"Termux library symlink escapes its package: {source.name}")
            if destination.exists() or destination.is_symlink():
                if not destination.is_symlink() or os.readlink(destination) != target:
                    raise ValueError(f"conflicting Termux library payload: {source.name}")
                continue
            destination.symlink_to(target)
            continue
        if not source.is_file():
            raise ValueError(f"unsupported Termux library member: {source.name}")
        if destination.exists():
            if not destination.is_file() or sha256(destination) != sha256(source):
                raise ValueError(f"conflicting Termux library bytes: {source.name}")
            continue
        shutil.copy2(source, destination)


def termux_shared_license_root(bootstrap_usr: Path) -> Path:
    if bootstrap_usr.is_symlink() or not bootstrap_usr.is_dir():
        raise ValueError("official Termux bootstrap root is missing or unsafe")
    bootstrap_root = bootstrap_usr.resolve(strict=True)
    candidate = bootstrap_usr / "share" / "LICENSES"
    if candidate.is_symlink() or not candidate.is_dir():
        raise ValueError("official Termux bootstrap omitted its shared license directory")
    resolved = candidate.resolve(strict=True)
    if not resolved.is_relative_to(bootstrap_root) or not resolved.is_dir():
        raise ValueError("official Termux shared license directory escapes the bootstrap")
    return resolved


def copy_copyright(prefix: Path, package_name: str, destination: Path,
                   shared_license_root: Path) -> dict[str, str]:
    source = prefix / "share" / "doc" / package_name / "copyright"
    if not source.exists() and not source.is_symlink():
        raise ValueError(f"Termux package omitted copyright notice: {package_name}")
    package_root = prefix.resolve(strict=True)
    if shared_license_root.is_symlink() or not shared_license_root.is_dir():
        raise ValueError("official Termux shared license directory is missing or unsafe")
    shared_root = shared_license_root.resolve(strict=True)
    package_shared_root = (package_root / "share" / "LICENSES").resolve(strict=False)
    if not package_shared_root.is_relative_to(package_root):
        raise ValueError(f"Termux package shared license path escapes its package: {package_name}")
    try:
        resolved = source.resolve(strict=True)
        origin = f"signed-termux-package:{package_name}/share/doc/{package_name}/copyright"
    except FileNotFoundError as error:
        # Termux uses relative links such as ../../LICENSES/GPL-3.0.txt for
        # generic notices. The standalone .deb omits that shared directory;
        # resolve only that exact in-prefix location against the authenticated
        # official bootstrap's license tree.
        unresolved = source.resolve(strict=False)
        if not unresolved.is_relative_to(package_shared_root):
            raise ValueError(f"Termux copyright notice has a missing non-shared target: {package_name}") from error
        relative = unresolved.relative_to(package_shared_root)
        if not relative.parts:
            raise ValueError(f"Termux copyright notice does not identify a shared license file: {package_name}")
        try:
            resolved = (shared_root / relative).resolve(strict=True)
        except FileNotFoundError as missing:
            raise ValueError(f"official Termux bootstrap omitted shared license {relative.as_posix()}") from missing
        if not resolved.is_relative_to(shared_root):
            raise ValueError(f"Termux shared license target escapes the official bootstrap: {package_name}")
        origin = f"official-termux-bootstrap:share/LICENSES/{relative.as_posix()}"
    if not resolved.is_relative_to(package_root) and not resolved.is_relative_to(shared_root):
        raise ValueError(f"Termux copyright notice escapes its authenticated roots: {package_name}")
    if not resolved.is_file():
        raise ValueError(f"Termux copyright notice is not a file: {package_name}")
    target = destination / package_name / "copyright"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(resolved, target)
    return {"package": package_name, "destination": f"{package_name}/copyright", "source": origin}


def termux_library(prefix: Path, stem: str) -> Path:
    """Resolve a regular library file from one authenticated package prefix."""
    directory = prefix / "lib"
    candidates = sorted(directory.glob(stem + ".so.*"), key=lambda item: item.name, reverse=True)
    candidates += [directory / (stem + ".so")]
    for candidate in candidates:
        if not candidate.exists() and not candidate.is_symlink():
            continue
        resolved = candidate.resolve(strict=True)
        if not resolved.is_file() or not resolved.is_relative_to(prefix.resolve(strict=True)):
            raise ValueError(f"Termux shared library escapes its package: {candidate.name}")
        return resolved
    raise ValueError(f"Termux package omitted {stem} shared library")


def _elf_program_headers(data: bytearray):
    if len(data) < 64 or data[:4] != b"\x7fELF" or data[4:7] != b"\x02\x01\x01":
        raise ValueError("Termux PRoot executable is not ELF64 little-endian")
    if int.from_bytes(data[18:20], "little") != 183:
        raise ValueError("Termux PRoot executable is not AArch64")
    phoff = int.from_bytes(data[32:40], "little")
    entsize = int.from_bytes(data[54:56], "little")
    count = int.from_bytes(data[56:58], "little")
    if entsize < 56 or count == 0 or phoff + entsize * count > len(data):
        raise ValueError("Termux PRoot executable has an invalid program header table")
    headers = []
    for index in range(count):
        offset = phoff + index * entsize
        headers.append({
            "type": int.from_bytes(data[offset:offset + 4], "little"),
            "offset": int.from_bytes(data[offset + 8:offset + 16], "little"),
            "vaddr": int.from_bytes(data[offset + 16:offset + 24], "little"),
            "filesz": int.from_bytes(data[offset + 32:offset + 40], "little"),
        })
    return headers


def patch_needed_library(data: bytearray, old: bytes, new: bytes) -> bool:
    """Patch one reviewed DT_NEEDED name without changing ELF size/layout."""
    if len(new) > len(old):
        raise ValueError("replacement DT_NEEDED name is longer than its input")
    headers = _elf_program_headers(data)
    dynamic = next((header for header in headers if header["type"] == 2), None)
    loads = [header for header in headers if header["type"] == 1]
    if dynamic is None:
        raise ValueError("Termux PRoot executable has no PT_DYNAMIC")
    dyn_offset, dyn_size = dynamic["offset"], dynamic["filesz"]
    if dyn_size % 16 or dyn_offset + dyn_size > len(data):
        raise ValueError("Termux PRoot executable has an invalid PT_DYNAMIC")
    strtab_address = None
    strtab_size = None
    needed_offsets = []
    for offset in range(dyn_offset, dyn_offset + dyn_size, 16):
        tag = int.from_bytes(data[offset:offset + 8], "little", signed=True)
        value = int.from_bytes(data[offset + 8:offset + 16], "little")
        if tag == 0:
            break
        if tag == 1:
            needed_offsets.append(value)
        elif tag == 5:
            strtab_address = value
        elif tag == 10:
            strtab_size = value
    if strtab_address is None or strtab_size is None:
        raise ValueError("Termux PRoot executable has no bounded dynamic string table")
    load = next((item for item in loads if item["vaddr"] <= strtab_address < item["vaddr"] + item["filesz"]), None)
    if load is None:
        raise ValueError("Termux PRoot dynamic string table is not file-backed")
    string_offset = load["offset"] + strtab_address - load["vaddr"]
    if string_offset + strtab_size > len(data):
        raise ValueError("Termux PRoot dynamic string table exceeds the ELF file")
    matches = []
    renamed_matches = []
    for needed in needed_offsets:
        if needed >= strtab_size:
            raise ValueError("Termux PRoot DT_NEEDED offset is out of bounds")
        start = string_offset + needed
        end = data.find(0, start, string_offset + strtab_size)
        if end < 0:
            raise ValueError("Termux PRoot DT_NEEDED string is unterminated")
        value = bytes(data[start:end])
        if value == old:
            matches.append((start, end))
        elif value == new:
            renamed_matches.append((start, end))
    if not matches:
        if len(renamed_matches) == 1:
            return False
        if len(renamed_matches) > 1:
            raise ValueError("Termux PRoot has duplicate renamed dependency entries")
        raise ValueError(f"Termux PRoot does not reference the reviewed dependency {old.decode()}")
    if len(matches) != 1 or renamed_matches:
        raise ValueError("Termux PRoot has duplicate reviewed DT_NEEDED entries")
    start, end = matches[0]
    replacement = new + b"\0" * (end - start - len(new))
    data[start:end] = replacement
    return True


def assemble(webroot_arg: str, provenance_arg: str, inputs_arg: str, bootstrap_usr_arg: str,
             backend_arg: str, native_arg: str) -> dict:
    webroot = Path(webroot_arg).resolve(strict=True)
    provenance_path = Path(provenance_arg).resolve(strict=True)
    inputs_path = Path(inputs_arg).resolve(strict=True)
    bootstrap_usr = Path(bootstrap_usr_arg).resolve(strict=True)
    backend = Path(backend_arg).resolve()
    native_root = Path(native_arg).resolve()
    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    inputs = json.loads(inputs_path.read_text(encoding="utf-8"))
    backend_config = json.loads((Path(__file__).with_name("linux-backend-packages.json")).read_text(encoding="utf-8"))
    if provenance.get("repository") != TERMUX_REPOSITORY or provenance.get("suite") != "stable":
        raise ValueError("Termux provenance repository or suite is not approved")
    signed_records = authenticated_package_index(webroot, provenance, bootstrap_usr)
    provenance_packages = provenance.get("packages")
    if not isinstance(provenance_packages, list):
        raise ValueError("Termux provenance package list is invalid")
    if provenance.get("packageCount") != len(provenance_packages):
        raise ValueError("Termux provenance package count does not match its package list")
    if any(not isinstance(item, dict) or not isinstance(item.get("package"), str)
           or not isinstance(item.get("purposes"), list)
           or any(not isinstance(purpose, str) for purpose in item.get("purposes", []))
           for item in provenance_packages):
        raise ValueError("Termux provenance package record is malformed")
    packages = [item for item in provenance_packages if "linux-backend" in item["purposes"]]
    by_name = {item.get("package"): item for item in packages}
    required = set(backend_config.get("requiredClosure", []))
    if not required or any(not isinstance(name, str) for name in required):
        raise ValueError("reviewed Termux PRoot package closure is invalid")
    if len(packages) != len(by_name):
        raise ValueError("Termux PRoot provenance contains duplicate package records")
    if not required.issubset(by_name):
        raise ValueError("signed Termux PRoot closure is incomplete: " + ", ".join(sorted(required - by_name.keys())))
    if set(by_name) != required:
        raise ValueError("Termux PRoot provenance contains packages outside the reviewed dependency closure")
    for package, item in by_name.items():
        record = signed_records.get(package)
        if not record:
            raise ValueError(f"Termux package is absent from the signed index: {package}")
        for provenance_key, signed_key in (("version", "Version"), ("architecture", "Architecture"),
                                           ("filename", "Filename"), ("sha256", "SHA256")):
            if item.get(provenance_key) != record.get(signed_key):
                raise ValueError(f"Termux package provenance differs from signed index: {package} {provenance_key}")
        if record.get("Architecture") != "aarch64":
            raise ValueError(f"Termux package must target aarch64: {package}")
    version = by_name["proot"].get("version", "")
    expected_versions = backend_config.get("expectedVersions")
    package_sources = backend_config.get("packageSources")
    if not isinstance(package_sources, dict) or set(package_sources) != required or set(expected_versions) != required:
        raise ValueError("reviewed Termux PRoot source and license records are incomplete")
    if package_sources["proot"].get("sourceUrl") != inputs.get("prootSourceUrl") \
            or package_sources["proot"].get("sourceSha256") != inputs.get("prootSourceSha256"):
        raise ValueError("PRoot source pins differ between Linux input locks")
    for package, expected_version in expected_versions.items():
        if by_name[package].get("version") != expected_version:
            raise ValueError(f"Termux {package} version is not reviewed: {by_name[package].get('version')!r}")
    if version != inputs.get("prootVersion"):
        raise ValueError(f"Termux PRoot input version differs from the package lock: {version!r}")
    if by_name["proot"].get("architecture") != "aarch64":
        raise ValueError("Termux PRoot package must target aarch64")
    if backend.exists() or backend.is_symlink():
        raise ValueError("backend destination must not already exist")
    if native_root.exists() or native_root.is_symlink():
        raise ValueError("native library destination must not already exist")
    backend.mkdir(parents=True)
    abi = native_root / "arm64-v8a"
    abi.mkdir(parents=True)

    with tempfile.TemporaryDirectory(prefix="linux-proot-deb-") as scratch:
        scratch_root = Path(scratch)
        package_prefixes = {}
        for index, item in enumerate(sorted(packages, key=lambda value: value["package"])):
            package = item.get("package")
            filename = item.get("filename")
            expected_hash = item.get("sha256")
            if not isinstance(package, str) or not isinstance(filename, str) or not isinstance(expected_hash, str):
                raise ValueError("Termux package provenance entry is incomplete")
            deb = safe_package_file(webroot, filename)
            if sha256(deb) != expected_hash:
                raise ValueError(f"Termux package hash differs from authenticated provenance: {package}")
            extracted = scratch_root / f"package-{index}"
            extracted.mkdir()
            subprocess.run(["dpkg-deb", "--extract", str(deb), str(extracted)], check=True)
            package_prefixes[package] = package_prefix(extracted)

        proot_prefix = package_prefixes["proot"]
        proot = proot_prefix / "bin" / "proot"
        loader = proot_prefix / "libexec" / "proot" / "loader"
        if not proot.is_file() or proot.is_symlink():
            raise ValueError("Termux PRoot package omitted a regular executable")
        proot_bytes = bytearray(proot.read_bytes())
        patched_talloc = patch_needed_library(proot_bytes, b"libtalloc.so.2", b"libtalloc.so")
        patched_proot = backend / "bin" / "proot"
        patched_proot.parent.mkdir(parents=True, exist_ok=True)
        patched_proot.write_bytes(proot_bytes)
        patched_proot.chmod(0o755)
        native_proot = abi / "libpocketharness_proot.so"
        shutil.copyfile(patched_proot, native_proot)
        native_proot.chmod(0o755)

        for source, target in [
            (loader, backend / "libexec" / "proot" / "loader"),
            (loader, abi / "libpocketharness_proot_loader.so"),
        ]:
            if not source.is_file() or source.is_symlink():
                raise ValueError(f"Termux PRoot package omitted a regular executable: {source.relative_to(proot_prefix)}")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            target.chmod(0o755)

        backend_lib = backend / "lib"
        for prefix in package_prefixes.values():
            copy_shared_libraries(prefix / "lib", backend_lib)

        talloc = termux_library(package_prefixes["libtalloc"], "libtalloc")
        shmem = termux_library(package_prefixes["libandroid-shmem"], "libandroid-shmem")
        for source, name in [(talloc, "libtalloc.so"), (shmem, "libandroid-shmem.so")]:
            shutil.copyfile(source, backend_lib / name)
            shutil.copyfile(source, abi / name)
            (backend_lib / name).chmod(0o755)
            (abi / name).chmod(0o755)

        licenses = backend / "share" / "licenses"
        shared_license_root = termux_shared_license_root(bootstrap_usr)
        license_origins = []
        for package, prefix in package_prefixes.items():
            license_origins.append(copy_copyright(prefix, package, licenses, shared_license_root))
        shutil.copyfile(Path(__file__).resolve().parents[2] / "LICENSES" / "GPL-2.0.txt", backend / "LICENSE-GPL-2.0.txt")
        compat_dir = licenses / "pocket-harness-termfold-compat"
        compat_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(__file__).resolve().parents[2] / "vendor/linux-proot/compat/LICENSE", compat_dir / "LICENSE")
        shutil.copyfile(Path(__file__).resolve().parents[2] / "vendor/linux-proot/compat/NOTICE.md", compat_dir / "NOTICE.md")

    proot_path = abi / "libpocketharness_proot.so"
    loader_path = abi / "libpocketharness_proot_loader.so"
    if not os.access(proot_path, os.X_OK) or not os.access(loader_path, os.X_OK):
        raise ValueError("assembled PRoot executable or native loader is not executable")
    report = {
        "schemaVersion": 1,
        "repository": provenance.get("repository"),
        "signedIndex": provenance.get("index"),
        "target": "proot",
        "targetVersion": version,
        "compatibilityShim": {
            **json.loads((Path(__file__).resolve().parents[2] / "vendor/linux-proot/compat/SOURCE.json").read_text(encoding="utf-8")),
            "localSourceSha256": sha256(Path(__file__).resolve().parents[2] / "vendor/linux-proot/compat/termfold_compat.c"),
        },
        "source": {
            "repository": inputs.get("prootRepository"),
            "url": inputs.get("prootSourceUrl"),
            "sha256": inputs.get("prootSourceSha256"),
        },
        "packages": [{
            **{key: item.get(key) for key in ("package", "version", "architecture", "source", "filename", "sha256")},
            **package_sources[item["package"]],
        } for item in sorted(packages, key=lambda value: value["package"])],
        "patchedTallocNeeded": patched_talloc,
        "licenseOrigins": sorted(license_origins, key=lambda item: item["package"]),
        "sharedLicenseSource": "official-termux-bootstrap:share/LICENSES",
        "licenseFiles": [
            {"path": str(item.relative_to(licenses)), "size": item.stat().st_size, "sha256": sha256(item)}
            for item in sorted(licenses.rglob("*")) if item.is_file() and not item.is_symlink()
        ],
        "nativeLibraries": [
            {"name": item.name, "size": item.stat().st_size, "sha256": sha256(item)}
            for item in sorted(abi.iterdir(), key=lambda value: value.name)
        ],
    }
    report_path = backend.parent / "proot-backend-inputs.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    if len(sys.argv) != 7:
        raise SystemExit("usage: prepare-proot-backend.py <termux-webroot> <termux-provenance.json> <linux-inputs.json> <extracted-bootstrap-usr> <backend-dir> <native-libs-dir>")
    result = assemble(*sys.argv[1:])
    print("assembled authenticated Termux PRoot closure: " + result["targetVersion"])
