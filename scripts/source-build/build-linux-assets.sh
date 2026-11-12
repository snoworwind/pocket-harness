#!/usr/bin/env bash
# Compile only reviewed in-tree sources; external bytes are official pinned inputs.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$ROOT"
node scripts/check-vendored-linux-bootstrap.mjs
node scripts/source-build/check-linux-sources.mjs
python3 scripts/source-build/linux-debian-snapshot-wget.py --self-test
SOURCE_PROOF_INPUTS=(
  vendor/linux-proot vendor/dsh-linux-runtime
  plugins/dsh-linux-bootstrap/README.md plugins/dsh-linux-bootstrap/build-client.mjs
  plugins/dsh-linux-bootstrap/build.mjs plugins/dsh-linux-bootstrap/client
  plugins/dsh-linux-bootstrap/package-lock.json plugins/dsh-linux-bootstrap/package.json
  plugins/dsh-linux-bootstrap/src plugins/dsh-linux-bootstrap/test
  scripts/source-build/build-linux-assets.sh scripts/source-build/retry-curl.sh scripts/source-build/linux-inputs.json
  scripts/source-build/linux-backend-packages.json scripts/source-build/linux-source-manifest.json
  scripts/snapshot-config/preinstall.json scripts/lib/shell.mjs
  scripts/source-build/build-proot-source.py scripts/source-build/proot-source
  scripts/source-build/inventory-native-runtime.py scripts/source-build/test_native_runtime_inventory.py
  scripts/source-build/guest-tools.json scripts/source-build/verify-guest-tools.py scripts/source-build/build-guest-addons.py
  scripts/source-build/proot_source_provenance.py
  scripts/source-build/prepare-proot-source-backend.py scripts/source-build/test_proot_source_build.py
  scripts/source-build/test_proot_source_backend.py scripts/source-build/ensure-no-rootfs-mounts.py \
  scripts/source-build/linux-debian-snapshot-wget.py scripts/source-build/test_linux_debian_snapshot_wget.py
  scripts/source-build/linux-assets-workflow.test.mjs
  scripts/source-build/package-linux-assets.py scripts/source-build/check-linux-sources.mjs
  scripts/source-build/check-linux-sources.test.mjs scripts/source-build/check-linux-native-libraries.mjs
  scripts/check-vendored-linux-bootstrap.mjs
  scripts/source-build/verify-linux-native-apk.py scripts/source-build/test_prepare_termux_signed_repo.py
  scripts/source-build/test_prepare_proot_backend.py scripts/source-build/test_prepare_rootfs_proot.py
  scripts/source-build/test_ensure_no_rootfs_mounts.py scripts/source-build/test_proot_compat.py
  scripts/source-build/test_package_linux_assets.py scripts/source-build/test_prepare_termux_bootstrap.py
  scripts/source-build/seed-dsh-profiles.mjs scripts/third-party-licenses.json
  scripts/check-third-party.mjs scripts/check-third-party.test.mjs LICENSE LICENSES docs/AGENTS/gpl-compliance.md
  .github/workflows/build-linux-assets.yml
)
for source in "${SOURCE_PROOF_INPUTS[@]}"; do
  [[ -f "$source" || -d "$source" ]] || { echo "Linux source proof input is missing: $source" >&2; exit 1; }
done
SOURCE_PROOF_SYMLINK=$(find "${SOURCE_PROOF_INPUTS[@]}" -type l -print -quit)
[[ -z "$SOURCE_PROOF_SYMLINK" ]] || { echo "Linux source proof input is a symlink: $SOURCE_PROOF_SYMLINK" >&2; exit 1; }
(
  cd plugins/dsh-linux-bootstrap
  npm ci --no-audit --no-fund --fetch-retries=8 --fetch-retry-factor=2 \
    --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=30000 --fetch-timeout=300000
  npm run build
)
WORK="$ROOT/.deploy-tmp/linux-build"
[[ "$(realpath -m "$WORK")" == "$WORK" ]] || { echo 'Linux build root escapes workspace' >&2; exit 1; }
mkdir -p "$WORK/assets" "$WORK/input" "$WORK/provenance"
STAGE="$WORK/assets"
ROOTFS="$WORK/rootfs"
# Only remove generated PRoot staging destinations after the build root has been
# resolved and checked above. This keeps local retries deterministic.
rm -rf -- "$WORK/backend" "$WORK/native-libs"
THREADS=$(node --input-type=module -e 'import { XZ_THREADS, CPU_THREADS_CAP } from "./scripts/lib/shell.mjs"; console.log(Math.min(XZ_THREADS, CPU_THREADS_CAP))')
[[ "$THREADS" =~ ^[1-8]$ ]] || { echo 'DSH_CPU_THREADS must be 1..8' >&2; exit 1; }
export XZ_OPT="-T$THREADS -6"
EPOCH=$(git show -s --format=%ct HEAD)
NODE_VERSION=$(node -p 'require("./scripts/source-build/linux-inputs.json").node')
NODE_SHA=$(node -p 'require("./scripts/source-build/linux-inputs.json").nodeSha256')
NODE_HEADERS_SHA=$(node -p 'require("./scripts/source-build/linux-inputs.json").nodeHeadersSha256')
DEBIAN_SNAPSHOT=$(node -p 'require("./scripts/source-build/linux-inputs.json").debianSnapshot')
DEBIAN_SHA=$(node -p 'require("./scripts/source-build/linux-inputs.json").debianInReleaseSha256')
GUEST_TOOLS=$(node -p 'require("./scripts/source-build/guest-tools.json").packages.join(",")')
: "${DEBIAN_KEYRING:?DEBIAN_KEYRING must identify the pinned Debian archive keyring}"
: "${NDK_ROOT:?NDK_ROOT must identify the pinned Android NDK r30}"
test -s "$DEBIAN_KEYRING"
# Source builds consume archives, never Termux binary packages or bootstrap keys.
# Reject a redirected provenance parent before clearing only our own generated records.
[[ "$(realpath -m "$WORK/provenance")" == "$WORK/provenance" ]] || exit 1
rm -f -- "$WORK/provenance/proot-backend-inputs.json" "$WORK/provenance/proot-source-build-arm64.json"
rm -rf -- "$WORK/provenance/proot-source-archives"
PROOT_SOURCES="$WORK/input/proot-sources"
mkdir -p "$PROOT_SOURCES"
while IFS=$'\t' read -r name url sha; do
  archive="$PROOT_SOURCES/${url##*/}"
  if ! printf '%s  %s\n' "$sha" "$archive" | sha256sum --check --status 2>/dev/null; then
    bash scripts/source-build/retry-curl.sh --fail --location --retry 8 --retry-max-time 600 "$url" -o "$archive"
  fi
  printf '%s  %s\n' "$sha" "$archive" | sha256sum --check --strict
done < <(node -e 'const x=require("./scripts/source-build/linux-backend-packages.json"); for(const n of ["proot","libtalloc","libandroid-shmem"]) {const r=x.packageSources[n]; console.log([n,r.sourceUrl,r.sourceSha256].join("\t"));}')
source_build=$(mktemp -d "$WORK/proot-source-build.XXXXXX")
python3 scripts/source-build/build-proot-source.py "$PROOT_SOURCES" "$NDK_ROOT" "$source_build" --abi arm64
python3 scripts/source-build/prepare-proot-source-backend.py \
  "$source_build" "$PROOT_SOURCES" "$WORK/backend" "$WORK/native-libs" "$WORK/provenance" --abi arm64
NATIVE_LIBS="$WORK/native-libs/arm64-v8a"
aarch64-linux-gnu-readelf -h "$NATIVE_LIBS/libpocketharness_proot.so" | grep 'Machine:.*AArch64'
aarch64-linux-gnu-readelf -l "$NATIVE_LIBS/libpocketharness_proot.so" | grep '/system/bin/linker64'
aarch64-linux-gnu-readelf -h "$NATIVE_LIBS/libpocketharness_proot_loader.so" | grep 'Machine:.*AArch64'
if aarch64-linux-gnu-readelf -l "$NATIVE_LIBS/libpocketharness_proot_loader.so" | grep -q 'Requesting program interpreter'; then
  echo 'PRoot loader must be static and directly executable from nativeLibraryDir' >&2
  exit 1
fi
tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner -cJf \
  "$STAGE/proot-backend-aarch64.tar.xz" -C "$WORK/backend" bin lib libexec share LICENSE-GPL-2.0.txt

bash scripts/source-build/retry-curl.sh --fail --location --retry 8 --retry-max-time 600 "$DEBIAN_SNAPSHOT/dists/trixie/InRelease" -o "$WORK/input/debian-InRelease"
printf '%s  %s\n' "$DEBIAN_SHA" "$WORK/input/debian-InRelease" | sha256sum --check --strict
gpgv --keyring "$DEBIAN_KEYRING" "$WORK/input/debian-InRelease"
# Never recursively clean a leftover host bind mount or a redirected directory.
[[ "$(realpath -m "$ROOTFS")" == "$ROOTFS" ]] || exit 1
if [[ -e "$ROOTFS" || -L "$ROOTFS" ]]; then
  python3 scripts/source-build/ensure-no-rootfs-mounts.py "$ROOTFS"
fi
sudo rm -rf -- "$ROOTFS"
DEBOOTSTRAP_BIN="$WORK/debootstrap-bin"
[[ "$(realpath -m "$DEBOOTSTRAP_BIN")" == "$DEBOOTSTRAP_BIN" ]] || { echo 'Debootstrap wget shim directory escapes the build root' >&2; exit 1; }
if [[ -e "$DEBOOTSTRAP_BIN" || -L "$DEBOOTSTRAP_BIN" ]]; then
  [[ -d "$DEBOOTSTRAP_BIN" && ! -L "$DEBOOTSTRAP_BIN" ]] || { echo 'Debootstrap wget shim directory is not a real directory' >&2; exit 1; }
  rm -rf -- "$DEBOOTSTRAP_BIN"
fi
mkdir -p "$DEBOOTSTRAP_BIN"
install -m755 scripts/source-build/linux-debian-snapshot-wget.py "$DEBOOTSTRAP_BIN/wget"
REAL_WGET=$(command -v wget)
[[ "$REAL_WGET" == /* && -x "$REAL_WGET" ]] || { echo 'Cannot resolve the real wget executable' >&2; exit 1; }
sudo env "PATH=$DEBOOTSTRAP_BIN:$PATH" "DEBOOTSTRAP_REAL_WGET=$REAL_WGET" debootstrap --arch=arm64 --foreign --variant=minbase --components=main \
  --keyring="$DEBIAN_KEYRING" \
  --include="apt,bash,ca-certificates,debian-archive-keyring,libstdc++6,$GUEST_TOOLS" trixie "$ROOTFS" "$DEBIAN_SNAPSHOT"
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
# A foreign bootstrap leaves some alternatives unselected (awk/vim/nc point at
# /etc/alternatives entries that exist but have no target), so probes would report
# missing commands in an otherwise complete rootfs.
for alternative in $(sudo chroot "$ROOTFS" /bin/sh -c 'if [ -d /etc/alternatives ]; then ls /etc/alternatives; fi'); do
  sudo chroot "$ROOTFS" update-alternatives --auto "$alternative" >/dev/null 2>&1 || true
done
sudo chroot "$ROOTFS" /bin/bash -ec '/lib/ld-linux-aarch64.so.1 --version; /usr/bin/apt-get --version'
# QEMU user-mode probes run with the caller's uid. CI runners are uid 1001, which has no
# account inside the Debian rootfs, so ssh/passwd-aware tools fail with "No user exists for
# uid 1001". Run the probes as root (matching the local container) and hand the report back.
sudo python3 scripts/source-build/verify-guest-tools.py --rootfs "$ROOTFS" \
  --report "$WORK/provenance/guest-tools-report.json" --qemu /usr/bin/qemu-aarch64-static
sudo chown -R "$(id -u):$(id -g)" "$WORK/provenance"
cleanup_mounts
trap - EXIT

# 根文件系统收尾：删掉引导残留与 apt 缓存，再按兼容脚本归一化（与既有判据同源）。
sudo rm -rf -- "$ROOTFS/debootstrap" "$ROOTFS/var/lib/apt/lists" "$ROOTFS/var/cache/apt/archives" "$ROOTFS/etc/apt/sources.list.d"
sudo mkdir -p "$ROOTFS/var/lib/apt/lists/partial" "$ROOTFS/var/cache/apt/archives/partial" "$ROOTFS/etc/apt/sources.list.d"
sudo rm -f "$ROOTFS/etc/resolv.conf" "$ROOTFS/etc/machine-id" "$ROOTFS/var/lib/dbus/machine-id" "$ROOTFS/var/cache/ldconfig/aux-cache"
sudo find "$ROOTFS/var/log" -type f -exec truncate -s0 {} +
sudo sh vendor/linux-proot/scripts/prepare-rootfs.sh --rootfs "$ROOTFS"
sudo sh vendor/linux-proot/scripts/prepare-rootfs.sh --rootfs "$ROOTFS" --verify
test ! -e "$ROOTFS/etc/hostname"
printf '%s\n' '127.0.0.1 localhost' '::1 localhost ip6-localhost ip6-loopback' | diff - "$ROOTFS/etc/hosts"
if grep -RniE 'Acquire::(http|https)::Proxy|proxy=' "$ROOTFS/etc/apt/apt.conf.d"; then
  echo 'Rootfs verification found host-specific apt proxy configuration' >&2
  exit 1
fi

sudo tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner --exclude='./dev/*' --exclude='./proc/*' \
  -cJf "$STAGE/debian-minimal-aarch64.tar.xz" -C "$ROOTFS" .
sudo chmod 644 "$STAGE/debian-minimal-aarch64.tar.xz"

NODE_ARCHIVE="$WORK/input/node-v$NODE_VERSION-linux-arm64.tar.xz"
bash scripts/source-build/retry-curl.sh --fail --location --retry 8 --retry-max-time 600 "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz" -o "$NODE_ARCHIVE"
printf '%s  %s\n' "$NODE_SHA" "$NODE_ARCHIVE" | sha256sum --check --strict
PNPM_VERSION=$(node -p 'require("./scripts/source-build/linux-inputs.json").pnpm.version')
bash scripts/source-build/retry-curl.sh --fail --location --retry 8 --retry-max-time 600 "https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_VERSION.tgz" -o "$WORK/input/pnpm.tgz"
python3 scripts/source-build/package-linux-assets.py "$WORK" "$EPOCH"
qemu-aarch64-static -L "$ROOTFS" "$WORK/node-stage/bin/node" --version | grep -Fx "v$NODE_VERSION"
cp "$WORK/input/debian-InRelease" "$WORK/provenance/"
cp scripts/source-build/linux-inputs.json scripts/source-build/linux-source-manifest.json "$WORK/provenance/"
mkdir -p "$WORK/provenance/linux-native-licenses"
cp -a "$WORK/backend/share/licenses/." "$WORK/provenance/linux-native-licenses/"
install -D -m644 vendor/linux-proot/compat/LICENSE \
  "$WORK/provenance/linux-native-licenses/pocket-harness-termfold-compat/LICENSE"
printf '%s\n' "$(git rev-parse HEAD)" > "$WORK/provenance/project-source-commit.txt"
tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner \
  -cJf "$WORK/provenance/linux-component-source.tar.xz" "${SOURCE_PROOF_INPUTS[@]}" \
  .deploy-tmp/linux-build/provenance/proot-source-archives \
  .deploy-tmp/linux-build/provenance/proot-source-build-arm64.json
echo "Built verified ARM64 Linux assets: $STAGE"
