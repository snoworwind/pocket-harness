#!/usr/bin/env bash
# Compile only reviewed in-tree sources; external bytes are official pinned inputs.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$ROOT"
node scripts/check-vendored-linux-bootstrap.mjs
node scripts/source-build/check-linux-sources.mjs
SOURCE_PROOF_INPUTS=(
  vendor/linux-proot vendor/dsh-linux-runtime
  plugins/dsh-linux-bootstrap/README.md plugins/dsh-linux-bootstrap/build-client.mjs
  plugins/dsh-linux-bootstrap/build.mjs plugins/dsh-linux-bootstrap/client
  plugins/dsh-linux-bootstrap/package-lock.json plugins/dsh-linux-bootstrap/package.json
  plugins/dsh-linux-bootstrap/src plugins/dsh-linux-bootstrap/test
  scripts/source-build/build-linux-assets.sh scripts/source-build/linux-inputs.json
  scripts/source-build/linux-backend-packages.json scripts/source-build/linux-source-manifest.json
  scripts/snapshot-config/preinstall.json scripts/lib/shell.mjs
  scripts/source-build/prepare-termux-bootstrap.py scripts/source-build/prepare-termux-signed-repo.py
  scripts/source-build/prepare-proot-backend.py scripts/source-build/ensure-no-rootfs-mounts.py
  scripts/source-build/linux-assets-workflow.test.mjs
  scripts/source-build/package-linux-assets.py scripts/source-build/check-linux-sources.mjs
  scripts/source-build/check-linux-sources.test.mjs scripts/source-build/check-linux-native-libraries.mjs
  scripts/check-vendored-linux-bootstrap.mjs
  scripts/source-build/verify-linux-native-apk.py scripts/source-build/test_prepare_termux_signed_repo.py
  scripts/source-build/test_prepare_proot_backend.py scripts/source-build/test_prepare_rootfs_proot.py
  scripts/source-build/test_ensure_no_rootfs_mounts.py scripts/source-build/test_proot_compat.py
  scripts/source-build/test_package_linux_assets.py scripts/source-build/test_prepare_termux_bootstrap.py
  scripts/source-build/seed-dsh-profiles.mjs scripts/third-party-licenses.json
  scripts/check-third-party.mjs scripts/check-third-party.test.mjs LICENSES docs/AGENTS/gpl-compliance.md
  .github/workflows/build-linux-assets.yml
)
for source in "${SOURCE_PROOF_INPUTS[@]}"; do
  [[ -f "$source" || -d "$source" ]] || { echo "Linux source proof input is missing: $source" >&2; exit 1; }
done
SOURCE_PROOF_SYMLINK=$(find "${SOURCE_PROOF_INPUTS[@]}" -type l -print -quit)
[[ -z "$SOURCE_PROOF_SYMLINK" ]] || { echo "Linux source proof input is a symlink: $SOURCE_PROOF_SYMLINK" >&2; exit 1; }
(
  cd plugins/dsh-linux-bootstrap
  npm ci --no-audit --no-fund
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
DEBIAN_SNAPSHOT=$(node -p 'require("./scripts/source-build/linux-inputs.json").debianSnapshot')
DEBIAN_SHA=$(node -p 'require("./scripts/source-build/linux-inputs.json").debianInReleaseSha256')
: "${DEBIAN_KEYRING:?DEBIAN_KEYRING must identify the pinned Debian archive keyring}"
: "${TERMUX_WEBROOT:?TERMUX_WEBROOT must identify the authenticated Termux package mirror}"
: "${TERMUX_PROVENANCE:?TERMUX_PROVENANCE must identify Termux package provenance}"
: "${TERMUX_BOOTSTRAP_USR:?TERMUX_BOOTSTRAP_USR must identify the official Termux bootstrap keyring}"
test -s "$DEBIAN_KEYRING"
test -d "$TERMUX_BOOTSTRAP_USR/share/termux-keyring"
NATIVE_LIBS="$WORK/native-libs/arm64-v8a"
python3 scripts/source-build/prepare-proot-backend.py \
  "$TERMUX_WEBROOT" "$TERMUX_PROVENANCE" scripts/source-build/linux-inputs.json "$TERMUX_BOOTSTRAP_USR" \
  "$WORK/backend" "$WORK/native-libs"
aarch64-linux-gnu-readelf -h "$NATIVE_LIBS/libpocketharness_proot.so" | grep 'Machine:.*AArch64'
aarch64-linux-gnu-readelf -l "$NATIVE_LIBS/libpocketharness_proot.so" | grep '/system/bin/linker64'
aarch64-linux-gnu-readelf -h "$NATIVE_LIBS/libpocketharness_proot_loader.so" | grep 'Machine:.*AArch64'
if aarch64-linux-gnu-readelf -l "$NATIVE_LIBS/libpocketharness_proot_loader.so" | grep -q 'Requesting program interpreter'; then
  echo 'PRoot loader must be static and directly executable from nativeLibraryDir' >&2
  exit 1
fi
tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner -cJf \
  "$STAGE/proot-backend-aarch64.tar.xz" -C "$WORK/backend" bin lib libexec share LICENSE-GPL-2.0.txt

curl --fail --location --retry 3 "$DEBIAN_SNAPSHOT/dists/trixie/InRelease" -o "$WORK/input/debian-InRelease"
printf '%s  %s\n' "$DEBIAN_SHA" "$WORK/input/debian-InRelease" | sha256sum --check --strict
gpgv --keyring "$DEBIAN_KEYRING" "$WORK/input/debian-InRelease"
# Never recursively clean a leftover host bind mount or a redirected directory.
[[ "$(realpath -m "$ROOTFS")" == "$ROOTFS" ]] || exit 1
if [[ -e "$ROOTFS" || -L "$ROOTFS" ]]; then
  python3 scripts/source-build/ensure-no-rootfs-mounts.py "$ROOTFS"
fi
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
mkdir -p "$WORK/provenance"
aarch64-linux-gnu-gcc -shared -fPIC -O2 -Wall -Wextra -Werror \
  -ffile-prefix-map="$ROOT"=/usr/src/pocket-harness -fdebug-prefix-map="$ROOT"=/usr/src/pocket-harness \
  -Wl,-soname,libpocket-linux-compat.so \
  -o "$WORK/provenance/libpocket-linux-compat.so" vendor/linux-proot/compat/termfold_compat.c -ldl
sudo install -D -m755 "$WORK/provenance/libpocket-linux-compat.so" "$ROOTFS/opt/pocket-harness/libpocket-linux-compat.so"
sudo sh vendor/linux-proot/scripts/prepare-rootfs.sh --rootfs "$ROOTFS"
sudo sh vendor/linux-proot/scripts/prepare-rootfs.sh --rootfs "$ROOTFS" --verify
sha256sum "$NATIVE_LIBS"/*.so > "$WORK/provenance/linux-native-libraries.sha256"
node scripts/source-build/check-linux-native-libraries.mjs "$WORK/native-libs"
find "$ROOTFS/var/cache/apt/archives" -type f -name '*.deb' -print0 | sort -z | xargs -0 -r sha256sum > "$WORK/provenance/debian-debs.sha256"
# Keep future apt updates explicit, separate from the reproducible factory image.
sudo tee "$ROOTFS/etc/apt/sources.list" >/dev/null <<'SOURCES'
deb https://deb.debian.org/debian trixie main
deb https://deb.debian.org/debian trixie-updates main
deb https://security.debian.org/debian-security trixie-security main
SOURCES
sudo rm -f "$ROOTFS/etc/hostname"
sudo tee "$ROOTFS/etc/hosts" >/dev/null <<'HOSTS'
127.0.0.1 localhost
::1 localhost ip6-localhost ip6-loopback
HOSTS
sudo find "$ROOTFS/etc/apt/apt.conf.d" -maxdepth 1 -type f -iname '*proxy*' -delete
if sudo grep -RniE 'Acquire::(http|https)::Proxy|proxy=' "$ROOTFS/etc/apt/apt.conf.d"; then
  echo 'Unexpected host-specific apt proxy configuration in guest rootfs' >&2
  exit 1
fi
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
curl --fail --location --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz" -o "$NODE_ARCHIVE"
printf '%s  %s\n' "$NODE_SHA" "$NODE_ARCHIVE" | sha256sum --check --strict
python3 scripts/source-build/package-linux-assets.py "$WORK" "$EPOCH"
qemu-aarch64-static -L "$ROOTFS" "$WORK/node-stage/bin/node" --version | grep -Fx "v$NODE_VERSION"
cp "$WORK/input/debian-InRelease" "$WORK/provenance/"
cp scripts/source-build/linux-inputs.json scripts/source-build/linux-source-manifest.json "$WORK/provenance/"
cp "$WORK/proot-backend-inputs.json" "$WORK/provenance/"
mkdir -p "$WORK/provenance/linux-native-licenses"
cp -a "$WORK/backend/share/licenses/." "$WORK/provenance/linux-native-licenses/"
install -D -m644 vendor/linux-proot/compat/LICENSE \
  "$WORK/provenance/linux-native-licenses/pocket-harness-termfold-compat/LICENSE"
printf '%s\n' "$(git rev-parse HEAD)" > "$WORK/provenance/project-source-commit.txt"
tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner \
  -cJf "$WORK/provenance/linux-component-source.tar.xz" "${SOURCE_PROOF_INPUTS[@]}"
echo "Built verified ARM64 Linux assets: $STAGE"
