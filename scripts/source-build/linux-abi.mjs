#!/usr/bin/env node
// Single ABI mapping for the Linux guest toolchain and product layout.
export const LINUX_ABIS = ['arm64', 'x86_64']

export function linuxAbi(value = process.env.DSH_ABI || 'arm64') {
  if (!LINUX_ABIS.includes(value)) throw new Error(`unsupported Linux ABI: ${value}`)
  const arm = value === 'arm64'
  const nodePlatform = arm ? 'linux-arm64' : 'linux-x64'
  const legacy = arm ? 'arm64' : 'x86_64'
  return {
    abi: value,
    legacy,
    androidAbi: arm ? 'arm64-v8a' : 'x86_64',
    debianArch: arm ? 'arm64' : 'amd64',
    nodePlatform,
    nodeArchive: `node-v${'{version}'}-${nodePlatform}.tar.xz`,
    elfMachine: arm ? 183 : 62,
    elfName: arm ? 'AArch64' : 'x86-64',
    gcc: arm ? 'aarch64-linux-gnu-gcc' : 'x86_64-linux-gnu-gcc',
    readelf: arm ? 'aarch64-linux-gnu-readelf' : 'x86_64-linux-gnu-readelf',
    qemu: arm ? 'qemu-aarch64-static' : 'qemu-x86_64-static',
    rootfsAsset: `debian-minimal-${arm ? 'aarch64' : 'amd64'}.tar.xz`,
    prootBackendAsset: `proot-backend-${arm ? 'aarch64' : 'x86_64'}.tar.xz`,
    runtime: arm ? 'linux-arm64-glibc' : 'linux-x64-glibc',
    canvasBinding: arm ? '@napi-rs/canvas-linux-arm64-gnu' : '@napi-rs/canvas-linux-x64-gnu',
    canvasAndroid: arm ? '@napi-rs/canvas-android-arm64' : '@napi-rs/canvas-android-x64',
    addonPackage: arm ? '@deepseek-ai/node-addon-system-linux-arm64' : '@deepseek-ai/node-addon-system-linux-x64',
    addonDir: arm ? 'linux-arm64' : 'linux-x64',
    baseId: `debian-13-${legacy}-glibc-2`,
  }
}
