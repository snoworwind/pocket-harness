# Pocket Harness 0.14.9 (ARM64)

## Highlights
- Updated the embedded DeepSeek Harness source target to 0.2.1-rc.3. The rc.4 npm next package was excluded because no matching public source tag or commit provenance could be verified.
- Applied the official client branding profile to Android builds; the WebView title is “DeepSeek Harness”.
- App version 0.14.9 (versionCode 53).

## Install and upgrade
- Download pocket-harness-v0.14.9-source-arm64.apk from the [GitHub release](https://github.com/snoworwind/pocket-harness/releases/tag/hardening-source-625fd8e0311d-40473155658-1).
- ARM64 Android only. Install or upgrade by running adb install with -r -t and the downloaded APK path. The APK uses the independent Pocket Harness signing identity.
- After install, wait for first-run snapshot extraction/update to finish before force-stopping the app or running device suites.

## Verification
- GitHub Actions run 40473155658 completed successfully; the source build, independent APK verification, and signing checks passed.
- Installed over 0.14.8 on an Android 16 ARM64 AVD using host GPU; the app launched and the WebView title was verified.
- verify-webview-015 reported 38/39. Its remaining failure used a stale Settings selector; manual ADB navigation and CDP checks confirmed the Phone Control page and enabled reset control.

## Limitations
- Full device acceptance is incomplete. The AVD used the default API 36 image rather than the required Google APIs image. No model-backed multi-step task, landscape run, or physical ARM64 device test was completed.
- This release was published before the full acceptance matrix was completed. See the [emulator acceptance protocol](../../docs/AGENTS/emulator-test-protocol.md).

The attached CI notes.md preserves the build-time draft status; the GitHub release description records the post-build smoke test and current limitations.
