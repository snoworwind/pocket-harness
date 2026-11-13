#!/usr/bin/env python3
"""Single ABI mapping for the Linux guest toolchain and product layout."""
ABIS = ('arm64', 'x86_64')


def linux_abi(value='arm64'):
    if value not in ABIS:
        raise ValueError(f'unsupported Linux ABI: {value}')
    arm = value == 'arm64'
    legacy = 'arm64' if arm else 'x86_64'
    return dict(
        abi=value,
        legacy=legacy,
        android_abi='arm64-v8a' if arm else 'x86_64',
        debian_arch='arm64' if arm else 'amd64',
        node_platform='linux-arm64' if arm else 'linux-x64',
        elf_machine=183 if arm else 62,
        elf_name='AArch64' if arm else 'x86-64',
        gcc='aarch64-linux-gnu-gcc' if arm else 'x86_64-linux-gnu-gcc',
        readelf='aarch64-linux-gnu-readelf' if arm else 'x86_64-linux-gnu-readelf',
        qemu='qemu-aarch64-static' if arm else 'qemu-x86_64-static',
        rootfs_asset='debian-minimal-%s.tar.xz' % ('aarch64' if arm else 'amd64'),
        proot_asset='proot-backend-%s.tar.xz' % ('aarch64' if arm else 'x86_64'),
        runtime='linux-arm64-glibc' if arm else 'linux-x64-glibc',
        canvas_binding='@napi-rs/canvas-linux-arm64-gnu' if arm else '@napi-rs/canvas-linux-x64-gnu',
        canvas_android='@napi-rs/canvas-android-arm64' if arm else '@napi-rs/canvas-android-x64',
        addon_package='@deepseek-ai/node-addon-system-linux-arm64' if arm else '@deepseek-ai/node-addon-system-linux-x64',
        addon_dir='linux-arm64' if arm else 'linux-x64',
        base_id='debian-13-%s-glibc-2' % legacy,
    )
