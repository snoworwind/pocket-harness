#!/usr/bin/env bash
# Compile only reviewed in-tree sources; external bytes are official pinned inputs.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$ROOT"
node scripts/source-build/check-linux-sources.mjs
WORK="$ROOT/.deploy-tmp/linux-build"
[[ "$(realpath -m "$WORK")" == "$WORK" ]] || { echo 'Linux build root escapes workspace' >&2; exit 1; }
mkdir -p "$WORK/assets" "$WORK/input" "$WORK/provenance"
STAGE="$WORK/assets"
ROOTFS="$WORK/rootfs"
THREADS=$(node --input-type=module -e 'import { XZ_THREADS, CPU_THREADS_CAP } from "./scripts/lib/shell.mjs"; console.log(Math.min(XZ_THREADS, CPU_THREADS_CAP))')
[[ "$THREADS" =~ ^[1-8]$ ]] || { echo 'DSH_CPU_THREADS must be 1..8' >&2; exit 1; }
export XZ_OPT="-T$THREADS -6"
EPOCH=$(git show -s --format=%ct HEAD)
NODE_VERSION=$(node -p 'require("./scripts/source-build/linux-inputs.json").node')
NODE_SHA=$(node -p 'require("./scripts/source-build/linux-inputs.json").nodeSha256')
RUST_VERSION=$(node -p 'require("./scripts/source-build/linux-inputs.json").rust')
DEBIAN_SNAPSHOT=$(node -p 'require("./scripts/source-build/linux-inputs.json").debianSnapshot')
DEBIAN_SHA=$(node -p 'require("./scripts/source-build/linux-inputs.json").debianInReleaseSha256')
: "${NDK:?NDK must identify the verified Android NDK directory}"
: "${DEBIAN_KEYRING:?DEBIAN_KEYRING must identify the pinned Debian archive keyring}"
test -s "$DEBIAN_KEYRING"
TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
test -x "$TC/bin/aarch64-linux-android24-clang"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$TC/bin/aarch64-linux-android24-clang"
export CC_aarch64_linux_android="$TC/bin/aarch64-linux-android24-clang"
export AR_aarch64_linux_android="$TC/bin/llvm-ar"
export CARGO_TARGET_DIR="$WORK/cargo"
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
export RUSTFLAGS='-C link-arg=-Wl,--threads=1'
rustup toolchain install "$RUST_VERSION" --profile minimal --target aarch64-linux-android
rustup run "$RUST_VERSION" cargo build --release --locked --jobs "$THREADS" --target aarch64-linux-android --manifest-path vendor/bionilux/Cargo.toml
rustup run "$RUST_VERSION" cargo metadata --locked --format-version=1 --filter-platform aarch64-linux-android --manifest-path vendor/bionilux/Cargo.toml > "$WORK/provenance/cargo-metadata.json"
python3 scripts/source-build/collect-linux-licenses.py "$WORK/provenance/cargo-metadata.json" "$WORK/backend/share/licenses"
mkdir -p "$WORK/backend/bin" "$WORK/backend/lib" "$WORK/backend/scripts"
install -m755 "$CARGO_TARGET_DIR/aarch64-linux-android/release/bionilux" "$WORK/backend/bin/bionilux"
aarch64-linux-gnu-gcc -shared -fPIC -O2 -Wall -Wextra -Werror -Wl,-soname,libbionilux_preload.so \
  -Wl,-rpath,/usr/lib/aarch64-linux-gnu -o "$WORK/backend/lib/libbionilux_preload.so" vendor/bionilux/src/preload/hooks.c -pthread -ldl
install -m755 vendor/bionilux/scripts/prepare-rootfs.sh "$WORK/backend/scripts/prepare-rootfs.sh"
"$TC/bin/llvm-readelf" -h "$WORK/backend/bin/bionilux" | grep 'Machine:.*AArch64'
"$TC/bin/llvm-readelf" -l "$WORK/backend/bin/bionilux" | grep '/system/bin/linker64'
aarch64-linux-gnu-readelf -h "$WORK/backend/lib/libbionilux_preload.so" | grep 'Machine:.*AArch64'
tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner -cJf "$STAGE/bionilux-backend-aarch64.tar.xz" -C "$WORK/backend" bin lib scripts share

curl --fail --location --retry 3 "$DEBIAN_SNAPSHOT/dists/trixie/InRelease" -o "$WORK/input/debian-InRelease"
printf '%s  %s\n' "$DEBIAN_SHA" "$WORK/input/debian-InRelease" | sha256sum --check --strict
gpgv --keyring "$DEBIAN_KEYRING" "$WORK/input/debian-InRelease"
# Never recursively clean a leftover host bind mount or a redirected directory.
[[ "$(realpath -m "$ROOTFS")" == "$ROOTFS" ]] || exit 1
if mountpoint -q "$ROOTFS/dev" || mountpoint -q "$ROOTFS/proc"; then echo 'Previous rootfs contains mounts; refuse cleanup' >&2; exit 1; fi
sudo rm -rf -- "$ROOTFS"
sudo debootstrap --arch=arm64 --foreign --variant=minbase --components=main \
  --keyring="$DEBIAN_KEYRING" \
  --include=apt,bash,ca-certificates,debian-archive-keyring,libstdc++6 trixie "$ROOTFS" "$DEBIAN_SNAPSHOT"
sudo install -m755 /usr/bin/qemu-aarch64-static "$ROOTFS/usr/bin/qemu-aarch64-static"
sudo mkdir -p "$ROOTFS/dev" "$ROOTFS/proc"
cleanup_mounts() {
  local failed=0
  if mountpoint -q "$ROOTFS/proc"; then sudo umount "$ROOTFS/proc" || failed=1; fi
  if mountpoint -q "$ROOTFS/dev"; then sudo umount "$ROOTFS/dev" || failed=1; fi
  return "$failed"
}
trap 'cleanup_mounts || true' EXIT
sudo mount --bind /dev "$ROOTFS/dev"
sudo mount -t proc proc "$ROOTFS/proc"
sudo chroot "$ROOTFS" /debootstrap/debootstrap --second-stage
test "$(sudo chroot "$ROOTFS" dpkg --print-architecture)" = arm64
sudo chroot "$ROOTFS" /bin/bash -ec '/lib/ld-linux-aarch64.so.1 --version; /usr/bin/apt-get --version'
cleanup_mounts
trap - EXIT
sudo rm -f "$ROOTFS/usr/bin/qemu-aarch64-static"
sudo chroot "$ROOTFS" dpkg-query -W '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' > "$WORK/provenance/debian-packages.tsv"
find "$ROOTFS/var/cache/apt/archives" -type f -name '*.deb' -print0 | sort -z | xargs -0 -r sha256sum > "$WORK/provenance/debian-debs.sha256"
# Keep future apt updates explicit, separate from the reproducible factory image.
sudo tee "$ROOTFS/etc/apt/sources.list" >/dev/null <<'SOURCES'
deb https://deb.debian.org/debian trixie main
deb https://deb.debian.org/debian trixie-updates main
deb https://security.debian.org/debian-security trixie-security main
SOURCES
sudo rm -rf -- "$ROOTFS/debootstrap" "$ROOTFS/var/lib/apt/lists" "$ROOTFS/var/cache/apt/archives" "$ROOTFS/etc/apt/sources.list.d"
sudo mkdir -p "$ROOTFS/var/lib/apt/lists/partial" "$ROOTFS/var/cache/apt/archives/partial" "$ROOTFS/etc/apt/sources.list.d"
sudo rm -f "$ROOTFS/etc/resolv.conf" "$ROOTFS/etc/machine-id" "$ROOTFS/var/lib/dbus/machine-id" "$ROOTFS/var/cache/ldconfig/aux-cache"
sudo find "$ROOTFS/var/log" -type f -exec truncate -s0 {} +
sudo sh vendor/bionilux/scripts/prepare-rootfs.sh --rootfs "$ROOTFS" --relative-links
sudo sh vendor/bionilux/scripts/prepare-rootfs.sh --rootfs "$ROOTFS" --relative-links --verify
sudo tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner --exclude='./dev/*' --exclude='./proc/*' \
  -cJf "$STAGE/debian-minimal-aarch64.tar.xz" -C "$ROOTFS" .
sudo chmod 644 "$STAGE/debian-minimal-aarch64.tar.xz"

NODE_ARCHIVE="$WORK/input/node-v$NODE_VERSION-linux-arm64.tar.xz"
curl --fail --location --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz" -o "$NODE_ARCHIVE"
printf '%s  %s\n' "$NODE_SHA" "$NODE_ARCHIVE" | sha256sum --check --strict
python3 scripts/source-build/package-linux-assets.py "$WORK" "$EPOCH"
qemu-aarch64-static -L "$ROOTFS" "$WORK/node-stage/bin/node" --version | grep -Fx "v$NODE_VERSION"
cp "$WORK/input/debian-InRelease" "$WORK/provenance/"
cp scripts/source-build/linux-inputs.json scripts/source-build/linux-source-manifest.json "$WORK/provenance/"
printf '%s\n' "$(git rev-parse HEAD)" > "$WORK/provenance/project-source-commit.txt"
tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner -cJf "$WORK/provenance/linux-component-source.tar.xz" \
  vendor/bionilux vendor/dsh-linux-runtime plugins/dsh-linux-bootstrap scripts/source-build/build-linux-assets.sh scripts/source-build/linux-inputs.json scripts/source-build/package-linux-assets.py
echo "Built verified ARM64 Linux assets: $STAGE"
