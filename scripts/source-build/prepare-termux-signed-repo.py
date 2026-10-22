#!/usr/bin/env python3
"""Fetch and authenticate the exact Termux packages used by the ARM64 snapshot."""
from __future__ import annotations

import gzip
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.request

from termux_signed_packages import _version_satisfies, safe_termux_package_filename, select_package_records

REPOSITORY = "https://packages.termux.dev/apt/termux-main"
SUITE_REL = "main/binary-aarch64/Packages.gz"
INDEX_REL = "dists/stable/" + SUITE_REL


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "dsh-source-build/1"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


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
                    raise ValueError(f"duplicate field in signed Termux package stanza: {key}")
                record[key] = value
            elif line.strip():
                raise ValueError(f"invalid line in signed Termux package stanza: {line!r}")
        if "Package" in record:
            yield record


DEPENDENCY_ATOM = re.compile(
    r"^([a-z0-9][a-z0-9+.-]*)(?::([a-z0-9-]+))?"
    r"(?:\s*\((<<|<=|=|>=|>>)\s*([^()\s]+)\))?"
    r"(?:\s*\[([^]]+)\])?(?:\s*<([^>]+)>)?$"
)


def _dependency_applies(expression: str, owner: str, records: dict[str, dict]) -> str | None:
    match = DEPENDENCY_ATOM.fullmatch(expression.strip())
    if not match:
        raise ValueError(f"cannot parse dependency for {owner}: {expression!r}")
    name, qualifier, operator, version, architecture_restriction, profiles = match.groups()
    if profiles:
        raise ValueError(f"unsupported build-profile dependency for {owner}: {expression!r}")
    if architecture_restriction:
        tokens = architecture_restriction.split()
        if not tokens or any(not re.fullmatch(r"!?[a-z0-9][a-z0-9-]*", token) for token in tokens):
            raise ValueError(f"unsupported architecture restriction for {owner}: {expression!r}")

        def matches_target(token: str) -> bool:
            # Termux calls the ABI aarch64; Debian dependency restrictions use arm64.
            # Their Linux wildcards describe the same AArch64 guest.
            return token in {"aarch64", "arm64", "any", "linux-any", "any-arm64", "any-aarch64",
                             "linux-arm64", "linux-aarch64"}

        positive = [token for token in tokens if not token.startswith("!")]
        excluded = [token[1:] for token in tokens if token.startswith("!")]
        if any(matches_target(token) for token in excluded):
            return None
        if positive and not any(matches_target(token) for token in positive):
            return None

    record = records.get(name)
    if record is None:
        return None
    architecture = record.get("Architecture")
    if architecture not in ("aarch64", "all"):
        return None
    if qualifier in ("aarch64", "arm64", "native"):
        if architecture not in ("aarch64", "all"):
            return None
    elif qualifier == "any":
        if record.get("Multi-Arch") not in ("allowed", "foreign"):
            return None
    elif qualifier is not None:
        raise ValueError(f"unsupported architecture qualifier for {owner}: {expression!r}")
    if operator and not _version_satisfies(record.get("Version", ""), operator, version):
        return None
    return name


def dependency_closure(records: dict[str, dict], seeds: list[str], purpose: str) -> set[str]:
    needed = set()
    queue = list(seeds)
    while queue:
        name = queue.pop(0)
        if name in needed:
            continue
        record = records.get(name)
        if not record:
            print(f"skip {purpose} package absent from signed index: {name}")
            continue
        if record.get("Architecture") not in ("aarch64", "all"):
            raise ValueError(f"{purpose} package has an incompatible architecture: {name}={record.get('Architecture')}")
        needed.add(name)
        for field in ("Pre-Depends", "Depends"):
            expression = record.get(field, "").strip()
            if not expression:
                continue
            for group in expression.split(","):
                choices = []
                for alternative in group.split("|"):
                    choice = _dependency_applies(alternative, name, records)
                    if choice:
                        choices.append(choice)
                if not choices:
                    raise ValueError(f"signed Termux index has no applicable alternative for {name}: {group.strip()}")
                queue.append(choices[0])
    return needed


def signed_sha256(release_text: str, relative_path: str) -> tuple[str, int]:
    marker = "SHA256:\n"
    if marker not in release_text:
        raise ValueError("verified Termux Release has no SHA256 section")
    section = release_text.split(marker, 1)[1]
    for line in section.splitlines():
        fields = line.split()
        if len(fields) == 3 and fields[2] == relative_path:
            return fields[0].lower(), int(fields[1])
        if not line.strip():
            break
    raise ValueError(f"signed Termux Release does not list {relative_path}")


def termux_recipe_url(source: dict, expected_commit: str) -> str:
    if not isinstance(expected_commit, str) or not re.fullmatch(r"[0-9a-f]{40}", expected_commit):
        raise ValueError("pinned Termux recipe commit is invalid")
    if source.get("recipeCommit") != expected_commit:
        raise ValueError("Termux package recipe commit differs from the source lock")
    recipe_path = source.get("recipePath")
    if not isinstance(recipe_path, str) or not re.fullmatch(r"packages/[a-z0-9][a-z0-9+.-]*/build\.sh", recipe_path):
        raise ValueError("Termux package recipe path is missing or unsafe")
    relative = pathlib.PurePosixPath(recipe_path)
    if relative.is_absolute() or str(relative) != recipe_path or not relative.parts or any(part in ("", ".", "..") for part in relative.parts):
        raise ValueError("Termux package recipe path is unsafe")
    expected_url = f"https://github.com/termux/termux-packages/blob/{expected_commit}/{recipe_path}"
    if source.get("recipe") != expected_url:
        raise ValueError("Termux package recipe URL is not the pinned immutable URL")
    if not isinstance(source.get("recipeSha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", source["recipeSha256"]):
        raise ValueError("Termux package recipe SHA-256 is invalid")
    return f"https://raw.githubusercontent.com/termux/termux-packages/{expected_commit}/{recipe_path}"


def verify_termux_recipe(source: dict, expected_commit: str, content: bytes) -> str:
    termux_recipe_url(source, expected_commit)
    actual_sha256 = hashlib.sha256(content).hexdigest()
    if actual_sha256 != source["recipeSha256"]:
        raise ValueError(f"Termux package recipe digest mismatch: {actual_sha256} != {source['recipeSha256']}")
    return actual_sha256


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: prepare-termux-signed-repo.py <extracted-bootstrap-usr> <webroot> <preinstall.json>")
    usr, webroot, preinstall_file = map(pathlib.Path, sys.argv[1:])
    key_dir = usr / "share" / "termux-keyring"
    keys = sorted(key_dir.glob("*.gpg"))
    if not keys:
        raise ValueError(f"official Termux signing keys are missing from {key_dir}")

    with tempfile.TemporaryDirectory(prefix="termux-gpg-") as temporary:
        home = pathlib.Path(temporary)
        home.chmod(0o700)
        for key in keys:
            subprocess.run(["gpg", "--homedir", str(home), "--batch", "--import", str(key)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        keyring = home / "termux-keys.gpg"
        with keyring.open("wb") as output:
            subprocess.run(["gpg", "--homedir", str(home), "--batch", "--export"],
                           check=True, stdout=output)

        inrelease = fetch(REPOSITORY + "/dists/stable/InRelease")
        inrelease_path = home / "InRelease"
        inrelease_path.write_bytes(inrelease)
        release_path = home / "Release"
        subprocess.run(["gpgv", "--keyring", str(keyring), "--output", str(release_path), str(inrelease_path)],
                       check=True)
        release_text = release_path.read_text(encoding="utf-8")
        # Termux stable is a rolling repository. Authenticate the current Release
        # with the pinned bootstrap keyring and record its digest as run provenance;
        # a repository publication must not require a source commit update.
        inrelease_hash = hashlib.sha256(inrelease).hexdigest()
    # Release checksums are relative to the suite root; the repository URL
    # and local apt layout additionally include dists/stable/.
    expected_index_hash, expected_index_size = signed_sha256(release_text, SUITE_REL)

    index_gz = fetch(REPOSITORY + "/" + INDEX_REL)
    actual_index_hash = hashlib.sha256(index_gz).hexdigest()
    if len(index_gz) != expected_index_size or actual_index_hash != expected_index_hash:
        raise ValueError("Termux Packages.gz does not match the signed Release file")
    records = select_package_records(parse_stanzas(gzip.decompress(index_gz).decode("utf-8")))
    config = json.loads(preinstall_file.read_text(encoding="utf-8"))
    backend_config_path = pathlib.Path(__file__).with_name("linux-backend-packages.json")
    backend_config = json.loads(backend_config_path.read_text(encoding="utf-8"))
    linux_inputs = json.loads(pathlib.Path(__file__).with_name("linux-inputs.json").read_text(encoding="utf-8"))
    recipe_commit = linux_inputs.get("termuxPackagesRecipeCommit")
    recipe_sources = backend_config.get("packageSources")
    if not isinstance(recipe_sources, dict) or not recipe_sources:
        raise ValueError("Termux package recipe lock is empty")
    for name, source in sorted(recipe_sources.items()):
        raw_url = termux_recipe_url(source, recipe_commit)
        recipe_hash = verify_termux_recipe(source, recipe_commit, fetch(raw_url))
        print(f"verified pinned Termux recipe {name} sha256={recipe_hash}")
    targets = config.get("targets")
    linux_backend_targets = backend_config.get("targets")
    if not isinstance(targets, list) or not isinstance(linux_backend_targets, list):
        raise ValueError("Termux snapshot and Linux backend target lists must be arrays")
    missing_required = [name for name in config.get("requiredTargets", []) if name not in records]
    if missing_required:
        raise ValueError(f"required Termux packages are absent from the signed index: {', '.join(missing_required)}")
    missing_backend = [name for name in backend_config.get("requiredTargets", []) if name not in records]
    if missing_backend:
        raise ValueError(f"required Linux backend packages are absent from the signed index: {', '.join(missing_backend)}")

    snapshot_needed = dependency_closure(records, targets, "snapshot")
    linux_backend_needed = dependency_closure(records, linux_backend_targets, "Linux backend")
    needed = snapshot_needed | linux_backend_needed

    webroot.mkdir(parents=True, exist_ok=True)
    if webroot.is_symlink() or not webroot.is_dir():
        raise ValueError("Termux webroot must be a real directory")
    inrelease_target = webroot / "dists" / "stable" / "InRelease"
    inrelease_target.parent.mkdir(parents=True, exist_ok=True)
    if inrelease_target.is_symlink() or inrelease_target.exists():
        raise ValueError("Termux InRelease destination is not a fresh regular path")
    inrelease_target.write_bytes(inrelease)
    index_path = webroot / INDEX_REL
    index_path.parent.mkdir(parents=True, exist_ok=True)
    if index_path.is_symlink() or index_path.exists():
        raise ValueError("Termux Packages.gz destination is not a fresh regular path")
    index_path.write_bytes(index_gz)
    package_provenance = []
    for name in sorted(needed):
        record = records[name]
        filename = record.get("Filename")
        if not filename:
            raise ValueError(f"signed package index has no Filename for {name}")
        relative = safe_termux_package_filename(filename)
        expected = record.get("SHA256", "").lower()
        if len(expected) != 64:
            raise ValueError(f"signed package index has no SHA256 for {name}")
        data = fetch(REPOSITORY + "/" + filename)
        actual = hashlib.sha256(data).hexdigest()
        if actual != expected:
            raise ValueError(f"Termux package digest mismatch: {name} {actual} != {expected}")
        target = webroot.joinpath(*relative.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink() or target.exists():
            raise ValueError(f"Termux package destination is not a fresh regular path: {filename}")
        target.write_bytes(data)
        purposes = []
        if name in snapshot_needed:
            purposes.append("snapshot")
        if name in linux_backend_needed:
            purposes.append("linux-backend")
        package_provenance.append({
            "package": name,
            "version": record.get("Version"),
            "architecture": record.get("Architecture"),
            "source": record.get("Source", name),
            "filename": filename,
            "sha256": actual,
            "purposes": purposes,
        })
        print(f"verified signed Termux package {name}={record.get('Version')} sha256={actual}")

    provenance = {
        "repository": REPOSITORY,
        "suite": "stable",
        "inRelease": {"path": "dists/stable/InRelease", "sha256": inrelease_hash},
        "index": {"path": INDEX_REL, "sha256": actual_index_hash, "signedReleaseSha256": inrelease_hash},
        "packageCount": len(package_provenance),
        "packages": package_provenance,
    }
    (webroot.parent / "termux-packages-provenance.json").write_text(
        json.dumps(provenance, indent=2) + "\n", encoding="utf-8"
    )
    print(f"verified {len(package_provenance)} Termux packages from signed InRelease {inrelease_hash}")


if __name__ == "__main__":
    main()
