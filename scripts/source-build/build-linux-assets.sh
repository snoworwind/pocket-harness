#!/usr/bin/env bash
# Compile only reviewed in-tree sources; external bytes are official pinned inputs.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$ROOT"
node scripts/source-build/check-linux-sources.mjs
python3 scripts/source-build/linux-debian-snapshot-wget.py --self-test
SOURCE_PROOF_INPUTS=(
  scripts/source-build/linux-abi.mjs scripts/source-build/linux-abi.py
  vendor/linux-proot
  scripts/source-build/build-linux-assets.sh scripts/source-build/retry-curl.sh scripts/source-build/linux-inputs.json
  scripts/source-build/linux-backend-packages.json scripts/source-build/linux-source-manifest.json
  scripts/runtime-config/preinstall.json scripts/lib/shell.mjs
  scripts/source-build/build-proot-source.py scripts/source-build/proot-source
  scripts/source-build/inventory-native-runtime.py scripts/source-build/test_native_runtime_inventory.py
  scripts/source-build/guest-tools.json scripts/source-build/verify-guest-tools.py scripts/source-build/build-guest-addons.py
  scripts/source-build/proot_source_provenance.py
  scripts/source-build/prepare-proot-source-backend.py scripts/source-build/test_proot_source_build.py
  scripts/source-build/test_proot_source_backend.py scripts/source-build/ensure-no-rootfs-mounts.py \
  scripts/source-build/linux-debian-snapshot-wget.py scripts/source-build/test_linux_debian_snapshot_wget.py
  scripts/source-build/linux-assets-workflow.test.mjs
  scripts/source-build/package-linux-product-assets.py scripts/source-build/check-linux-sources.mjs
  scripts/source-build/check-linux-sources.test.mjs scripts/source-build/check-linux-native-libraries.mjs
  scripts/source-build/verify-linux-native-apk.py
  scripts/source-build/test_prepare_proot_backend.py scripts/source-build/test_prepare_rootfs_proot.py
  scripts/source-build/test_ensure_no_rootfs_mounts.py scripts/source-build/test_proot_compat.py
  scripts/source-build/test_package_linux_assets.py
  scripts/source-build/seed-dsh-profiles.mjs scripts/third-party-licenses.json
  scripts/check-third-party.mjs scripts/check-third-party.test.mjs LICENSE LICENSES docs/AGENTS/gpl-compliance.md
  .github/workflows/build-linux-assets.yml
)
for source in "${SOURCE_PROOF_INPUTS[@]}"; do
  [[ -f "$source" || -d "$source" ]] || { echo "Linux source proof input is missing: $source" >&2; exit 1; }
done
SOURCE_PROOF_SYMLINK=$(find "${SOURCE_PROOF_INPUTS[@]}" -type l -print -quit)
[[ -z "$SOURCE_PROOF_SYMLINK" ]] || { echo "Linux source proof input is a symlink: $SOURCE_PROOF_SYMLINK" >&2; exit 1; }
ABI="${DSH_ABI:-arm64}"
case "$ABI" in arm64|x86_64) ;; *) echo "unsupported DSH_ABI: $ABI" >&2; exit 2;; esac
ABI_JSON=$(node --input-type=module -e "import { linuxAbi } from './scripts/source-build/linux-abi.mjs'; console.log(JSON.stringify(linuxAbi(process.argv[1])))" "$ABI")
abi() { node -e "console.log(JSON.parse(process.argv[1])[process.argv[2]])" "$ABI_JSON" "$1"; }
DEBIAN_ARCH=$(abi debianArch)
NODE_PLATFORM=$(abi nodePlatform)
ELF_MACHINE=$(abi elfName)
READELF=$(abi readelf)
CROSS_GCC=$(abi gcc)
QEMU_STATIC=$(abi qemu)
ROOTFS_ASSET=$(abi rootfsAsset)
PROOT_ASSET=$(abi prootBackendAsset)
ANDROID_ABI=$(abi androidAbi)
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
if [[ "$ABI" = arm64 ]]; then NODE_SHA=$(node -p 'require("./scripts/source-build/linux-inputs.json").nodeSha256'); else NODE_SHA=$(node -p 'require("./scripts/source-build/linux-inputs.json").nodeSha256X64'); fi
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
rm -f -- "$WORK/provenance/proot-backend-inputs.json" "$WORK/provenance/proot-source-build-$ABI.json"
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
python3 scripts/source-build/build-proot-source.py "$PROOT_SOURCES" "$NDK_ROOT" "$source_build" --abi "$ABI"
python3 scripts/source-build/prepare-proot-source-backend.py \
  "$source_build" "$PROOT_SOURCES" "$WORK/backend" "$WORK/native-libs" "$WORK/provenance" --abi "$ABI"
NATIVE_LIBS="$WORK/native-libs/$ANDROID_ABI"
"$READELF" -h "$NATIVE_LIBS/libpocketharness_proot.so" | grep -i "Machine:.*$ELF_MACHINE"
if [[ "$ABI" = arm64 ]]; then "$READELF" -l "$NATIVE_LIBS/libpocketharness_proot.so" | grep '/system/bin/linker64'; else "$READELF" -l "$NATIVE_LIBS/libpocketharness_proot.so" | grep '/system/bin/linker64'; fi
"$READELF" -h "$NATIVE_LIBS/libpocketharness_proot_loader.so" | grep -i "Machine:.*$ELF_MACHINE"
if "$READELF" -l "$NATIVE_LIBS/libpocketharness_proot_loader.so" | grep -q 'Requesting program interpreter'; then
  echo 'PRoot loader must be static and directly executable from nativeLibraryDir' >&2
  exit 1
fi
tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner -cJf \
  "$STAGE/$PROOT_ASSET" -C "$WORK/backend" bin lib libexec share LICENSE-GPL-2.0.txt

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
sudo env "PATH=$DEBOOTSTRAP_BIN:$PATH" "DEBOOTSTRAP_REAL_WGET=$REAL_WGET" debootstrap --arch="$DEBIAN_ARCH" --foreign --variant=minbase --components=main \
  --keyring="$DEBIAN_KEYRING" \
  --include="apt,bash,ca-certificates,debian-archive-keyring,libstdc++6,$GUEST_TOOLS" trixie "$ROOTFS" "$DEBIAN_SNAPSHOT"
sudo install -m755 "/usr/bin/$QEMU_STATIC" "$ROOTFS/usr/bin/$QEMU_STATIC"
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
test "$(sudo chroot "$ROOTFS" dpkg --print-architecture)" = "$DEBIAN_ARCH"
# A foreign bootstrap leaves some alternatives unselected (awk/vim/nc point at
# /etc/alternatives entries that exist but have no target), so probes would report
# missing commands in an otherwise complete rootfs.
for alternative in $(sudo chroot "$ROOTFS" /bin/sh -c 'if [ -d /etc/alternatives ]; then ls /etc/alternatives; fi'); do
  sudo chroot "$ROOTFS" update-alternatives --auto "$alternative" >/dev/null 2>&1 || true
done
if [[ "$ABI" = arm64 ]]; then sudo chroot "$ROOTFS" /bin/bash -ec '/lib/ld-linux-aarch64.so.1 --version; /usr/bin/apt-get --version'; else sudo chroot "$ROOTFS" /bin/bash -ec '/lib64/ld-linux-x86-64.so.2 --version; /usr/bin/apt-get --version'; fi
# QEMU user-mode probes run with the caller's uid. CI runners are uid 1001, which has no
# account inside the Debian rootfs, so ssh/passwd-aware tools fail with "No user exists for
# uid 1001". Run the probes as root (matching the local container) and hand the report back.
sudo python3 scripts/source-build/verify-guest-tools.py --rootfs "$ROOTFS" \
  --report "$WORK/provenance/guest-tools-report.json" --qemu "/usr/bin/$QEMU_STATIC"
sudo chown -R "$(id -u):$(id -g)" "$WORK/provenance"
cleanup_mounts
trap - EXIT

# Guest glibc addon: @deepseek-ai/node-addon-system-linux-arm64 is a first-party workspace
# package in the pinned harness source, not a registry prebuild, so it has to be compiled
# from that source (flock). node-pty needs no build: its npm tarball ships linux-arm64.
HEADERS_ARCHIVE="$WORK/input/node-v$NODE_VERSION-headers.tar.gz"
bash scripts/source-build/retry-curl.sh --fail --location --retry 8 --retry-max-time 600 "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-headers.tar.gz" -o "$HEADERS_ARCHIVE"
printf '%s  %s\n' "$NODE_HEADERS_SHA" "$HEADERS_ARCHIVE" | sha256sum --check --strict
rm -rf "$WORK/input/node-headers"
mkdir -p "$WORK/input/node-headers"
tar -xzf "$HEADERS_ARCHIVE" -C "$WORK/input/node-headers"
python3 scripts/source-build/build-guest-addons.py \
  --harness .deploy-tmp/deepseek-harness \
  --headers "$WORK/input/node-headers/node-v$NODE_VERSION/include/node" \
  --cc "$CROSS_GCC" --abi "$ABI" \
  --out "$WORK/guest-addons/system" | tee "$WORK/provenance/guest-addons-build.log"
cp "$WORK/guest-addons/system/guest-addons.json" "$WORK/provenance/guest-addons.json"

# Rootfs finalize: drop bootstrap residue, install the glibc compat preload that PRoot needs,
# then normalize and verify the guest image before archiving it.
sudo rm -f "$ROOTFS/usr/bin/$QEMU_STATIC"
sudo chroot "$ROOTFS" dpkg-query -W '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' > "$WORK/provenance/debian-packages.tsv"
mkdir -p "$WORK/provenance"
"$CROSS_GCC" -shared -fPIC -O2 -Wall -Wextra -Werror \
  -ffile-prefix-map="$ROOT"=/usr/src/pocket-harness -fdebug-prefix-map="$ROOT"=/usr/src/pocket-harness \
  -Wl,-soname,libpocket-linux-compat.so \
  -o "$WORK/provenance/libpocket-linux-compat.so" vendor/linux-proot/compat/termfold_compat.c -ldl
sudo install -D -m755 "$WORK/provenance/libpocket-linux-compat.so" "$ROOTFS/opt/pocket-harness/libpocket-linux-compat.so"
sudo rm -rf -- "$ROOTFS/debootstrap" "$ROOTFS/var/lib/apt/lists" "$ROOTFS/var/cache/apt/archives" "$ROOTFS/etc/apt/sources.list.d"
sudo mkdir -p "$ROOTFS/var/lib/apt/lists/partial" "$ROOTFS/var/cache/apt/archives/partial" "$ROOTFS/etc/apt/sources.list.d"
sudo rm -f "$ROOTFS/etc/resolv.conf" "$ROOTFS/etc/machine-id" "$ROOTFS/var/lib/dbus/machine-id" "$ROOTFS/var/cache/ldconfig/aux-cache"
sudo find "$ROOTFS/var/log" -type f -exec truncate -s0 {} +
sudo sh vendor/linux-proot/scripts/prepare-rootfs.sh --rootfs "$ROOTFS"
sudo sh vendor/linux-proot/scripts/prepare-rootfs.sh --rootfs "$ROOTFS" --verify
sudo rm -f "$ROOTFS/etc/hostname"
sudo tee "$ROOTFS/etc/hosts" >/dev/null <<'HOSTS'
127.0.0.1 localhost
::1 localhost ip6-localhost ip6-loopback
HOSTS
# Keep future apt updates explicit, separate from the reproducible factory image.
sudo tee "$ROOTFS/etc/apt/sources.list" >/dev/null <<'SOURCES'
deb https://deb.debian.org/debian trixie main
deb https://deb.debian.org/debian trixie-updates main
deb https://security.debian.org/debian-security trixie-security main
SOURCES
sudo find "$ROOTFS/etc/apt/apt.conf.d" -maxdepth 1 -type f -iname '*proxy*' -delete
if sudo grep -RniE 'Acquire::(http|https)::Proxy|proxy=' "$ROOTFS/etc/apt/apt.conf.d"; then
  echo 'Unexpected host-specific apt proxy configuration in guest rootfs' >&2
  exit 1
fi
sha256sum "$NATIVE_LIBS"/*.so > "$WORK/provenance/linux-native-libraries.sha256"
node scripts/source-build/check-linux-native-libraries.mjs "$WORK/native-libs" "$ABI"
find "$ROOTFS/var/cache/apt/archives" -type f -name '*.deb' -print0 | sort -z | xargs -0 -r sha256sum > "$WORK/provenance/debian-debs.sha256"

sudo tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner --exclude='./dev/*' --exclude='./proc/*' \
  -cJf "$STAGE/$ROOTFS_ASSET" -C "$ROOTFS" .
sudo chmod 644 "$STAGE/$ROOTFS_ASSET"

NODE_ARCHIVE="$WORK/input/node-v$NODE_VERSION-$NODE_PLATFORM.tar.xz"
bash scripts/source-build/retry-curl.sh --fail --location --retry 8 --retry-max-time 600 "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$NODE_PLATFORM.tar.xz" -o "$NODE_ARCHIVE"
printf '%s  %s\n' "$NODE_SHA" "$NODE_ARCHIVE" | sha256sum --check --strict
PNPM_VERSION=$(node -p 'require("./scripts/source-build/linux-inputs.json").pnpm.version')
bash scripts/source-build/retry-curl.sh --fail --location --retry 8 --retry-max-time 600 "https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_VERSION.tgz" -o "$WORK/input/pnpm.tgz"
python3 scripts/source-build/package-linux-product-assets.py "$WORK" "$EPOCH" --abi "$ABI"
"$QEMU_STATIC" -L "$ROOTFS" "$WORK/node-stage/bin/node" --version | grep -Fx "v$NODE_VERSION"
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
  ".deploy-tmp/linux-build/provenance/proot-source-build-$ABI.json"
echo "Built verified $ABI Linux assets: $STAGE"
