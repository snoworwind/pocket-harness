# `@dsh-android/dsh-android-vdisplay`

Pocket Harness' virtual-display plugin. It exposes virtual-display status and controls to the model and supplies metadata for the app's virtual-display viewer. Source and package metadata in this repository are authoritative.

## Model tools and status route

The plugin registers these model tools:

- `android_vdisplay_status` — read capability and runtime status.
- `android_vdisplay_create` / `android_vdisplay_destroy` — request virtual display lifecycle changes.
- `android_vdisplay_input` — send input to an eligible virtual display.

The viewer reads `GET /api/android/vdisplay/status`. It is a loopback-fenced, read-only metadata endpoint; it does not carry display pixels. See [`src/index.ts`](src/index.ts), [`src/status.ts`](src/status.ts), and [`src/client/index.ts`](src/client/index.ts) for the live contract and fail-closed state mapping.

## Pixel and control path

Pixels stay on the native side: a `SurfaceView` supplies the output surface to the Android virtual display. The browser sidebar hosts controls and status only; it does not encode frames through the engine or WebView. Virtual display creation, launch, and input use the shell/Shizuku-capable native control path. The `virtual-1` alias is not mapped to physical display 0 before a virtual display is ready.

## Build integration and acceptance

This plugin is mounted by the local source profile. Check `scripts/profile-web.cordis.patch.yml` and `package.json` for source-chain integration; generated `lib/` files are build outputs and are not source authority.

The 0.14.10 candidate has not completed CDP, ADB user-operation, landscape, or ARM64 device acceptance. In particular, real viewer lifecycle, display launch, and input behavior remain part of device verification. See [`release/v0.14.10/notes.md`](../../release/v0.14.10/notes.md), [`docs/AGENTS/known-gaps.md`](../../docs/AGENTS/known-gaps.md), and [`docs/AGENTS/emulator-test-protocol.md`](../../docs/AGENTS/emulator-test-protocol.md).
