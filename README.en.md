# Pocket Harness: an Android shell for agents

[中文](README.md) · [Latest release](https://github.com/snoworwind/pocket-harness/releases/latest)

Pocket Harness is an Android shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It bundles the WebView UI and a Termux runtime snapshot in one APK, so an agent can use bash and device capabilities without installing the Termux app.

## What it does

- **Run an agent** with an embedded Linux runtime, including bash, Node.js and project plugins.
- **Control the phone** through accessibility and Shizuku channels for UI inspection, input and screenshots.
- **Browse the web** in a browser workbench isolated from the main UI, with page and tab management.
- **Use a virtual display** to run and control third-party apps on a separate screen (requires Shizuku).
- **Handle files** through Android's file picker, share entry point and SAF directory bridge.

Model-visible capabilities are provided by plugins; the shell does not register tools directly. See the [bridge API](docs/AGENTS/BRIDGE-API.md) and plugin documentation for details.

## Download and install

The current release is **v0.14.9**, with ARM64 APKs only: [release notes and acceptance scope](release/v0.14.9/notes.md) · [GitHub Release](https://github.com/snoworwind/pocket-harness/releases/tag/hardening-source-625fd8e0311d-40473155658-1).

The repository is preparing a **v0.14.10 development candidate**. Its three-layer device acceptance is incomplete, and its draft release is unpublished; do not treat it as a stable release. See the [candidate notes](release/v0.14.10/notes.md) for progress.

```sh
adb install -r -t <apk>
```

Match the APK ABI to your device; x86_64 emulators are not supported. On first launch or after an in-place upgrade, the runtime snapshot takes several minutes to extract. Wait for it to finish and do not force-stop the app during extraction. Virtual displays and privileged shell features require Shizuku to be installed and authorized.

Third-party marketplace plugins have not all been adapted for phones and may be unusable or buggy. Do not rely on them as production dependencies. The current release passed its smoke test, but full three-layer device acceptance is incomplete; see the release notes for details.

## Build

APK files must be produced through the source-build chain. Only ARM64 is currently supported. To start a cloud build:

```sh
gh workflow run build-apk-source.yml --repo snoworwind/pocket-harness --ref main
```

For a local Linux / WSL source build (committed `HEAD` only):

```sh
node scripts/source-build/run-local-source-chain.mjs
```

See [build and environment](docs/AGENTS/build-and-env.md) and the [release policy](docs/RELEASE.md) for prerequisites, artifacts and verification requirements.

## Project docs

- [Security goals and hardening principles](docs/AGENTS/SECURITY-HARDENING.md)
- [Module and architecture map](docs/AGENTS/modules.md) · [Full version history](docs/AGENTS/changelog-archive.md)
- [Device acceptance protocol](docs/AGENTS/emulator-test-protocol.md)
- [Development entry point and repository conventions](AGENTS.md)

## Acknowledgments

Special thanks to [kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk). Pocket Harness was established as an independent project from the `security/hardening` branch of [snoworwind/dsh-mobile-apk](https://github.com/snoworwind/dsh-mobile-apk).

## License

MIT; original project copyright notices are retained. See [LICENSE](LICENSE). Third-party components are distributed under their respective licenses.
