# @dsh-android/linux-runtime

The **experimental** DSH Mobile Linux capability plugin: it installs,
health-checks and runs the Debian/glibc environment, and it owns the
Agent-facing `linux_bash` tool.

In this repository this package is vendored as a source/build input and is
packaged into the APK's ARM64 Termux snapshot by the source-build workflow. Its
assets are copied only after the same-commit provenance, manifest sidecar,
SHA-256 and size checks pass. It remains experimental and is **not enabled by
default**: presence is not activation. Android device installation and runtime
acceptance are pending.

## What this package owns

| Concern | Detail |
|---|---|
| Runtime lifecycle | `install`, `reinstall`, `uninstall`, `status`, `dispose` |
| Storage layout | `<dataDir>/instances/<id>/{backend,rootfs}` plus `<dataDir>/active.json` |
| Shared Node.js | One app-level glibc Node under `<dataDir>/shared/node/<nodeKey>/<arch>` |
| Guest environment | Derived, host-clean environment (see below) |
| Agent tool | `linux_bash`, registered only while the runtime is healthy |

Bionilux, the Debian minimal rootfs and the Node.js package are built from
source by the Linux asset workflow. The APK source workflow rebuilds these
assets for its own commit and embeds them beside this plugin, so runtime setup
does not depend on a private GitHub Release or network download. Runtime updates
arrive with a newly built APK; the embedded manifest and its raw-byte digest
sidecar are verified before the bootstrap accepts it.

## Shared glibc Node.js

DSH Mobile keeps running on its own Bionic Node.js, and Termux tooling is
unchanged. The Linux environment needs a *glibc* Node.js, and it installs one
shared copy for the whole app instead of one per rootfs:

* The shared package lives outside every rootfs, under
  `<dataDir>/shared/node/<nodeKey>/<arch>`, where `nodeKey` is
  `sha256-<nodeAsset.sha256>`.
* Because the key is the archive digest, a later Linux release that ships the
  same Node archive **reuses** the installed copy instead of downloading it
  again. A release that ships a different archive installs its own copy.
* The shared `bin` directory is added to the guest `PATH` (via
  `BIONILUX_GUEST_PATH`) and exposed through `BIONILUX_HOST_PATHS`, so
  `node`/`npm` inside the guest resolve to the glibc Node.js while host
  `BIONILUX_*`/Termux variables never leak in.
* Uninstalling the runtime removes the shared Node only when no other installed
  instance still references it.

## Execution contract

`execute({ command, cwd, timeout, signal })` runs `/bin/bash -lc <command>` as a
child of the Bionilux launcher and returns
`{ stdout, stderr, exitCode, signal, timedOut, cwd, runtimeId, architecture }`.

* **No silent fallback.** If the runtime is absent or unhealthy, the call fails
  with an explicit error. Nothing is ever re-run on the Termux shell.
* **Guest environment.** Only an allowlist of host variables is inherited
  (`PATH`, `LANG`/`TZ`/`TERM`, proxy variables, Android roots). Termux/`PREFIX`,
  `BIONILUX_*`, `LD_*`, and Node loader variables are never passed through.
  `BIONILUX_FAKE_ROOT=1` presents the guest's own root identity and
  `BIONILUX_LENIENT=0` keeps missing guest paths failing rather than reaching the
  host.
* **Working directory.** A path inside the rootfs maps to its guest path. A path
  outside the guest namespace (not under `/bin`, `/etc`, `/usr`, `/tmp`, …) that
  exists on the host stays visible under its own name. A path inside the guest
  namespace, or one that does not exist on the host, is treated as a guest path —
  promoting it to a host path would shadow the guest's own subtree, because the
  launcher resolves a configured host directory before consulting the rootfs. A
  relative path is rejected.

## Install/cutover safety

* Installation stages the backend, rootfs and Node, proves health on the staged
  tree, and only then swaps `active.json` atomically. A failed install leaves the
  previously active instance running.
* One manager instance owns one `dataDir`. Command execution and
  install/uninstall are separated by a read/write gate: an in-flight command is
  aborted before a cutover, and a command issued during a cutover waits for it.
  Cross-process serialization belongs to the bootstrap plugin's install lock.
* `uninstall` removes only the runtime instance, its metadata and unreferenced
  shared Node directories; user workspaces and DSH data are untouched.

## Cordis integration

```js
import linuxRuntime from '@dsh-android/linux-runtime'

// The host adapter (linuxPluginHost) loads this entry and passes the runtime
// coordinates; it then returns the manager to the bootstrap plugin.
const manager = ctx.plugin(linuxRuntime, {
  dataDir: '<filesDir>/linux-environment/runtime',
  arch: 'arm64',
  downloadAsset,   // checksum-verifying downloader
  extractArchive,  // safe extractor (no shell tar)
})
```

`apply(ctx, config)` creates the manager, publishes it as
`ctx.linuxRuntimeManager`, and registers `linux_bash` whenever the runtime is
healthy (re-evaluated on every state change).

## The two shells, as the Agent sees them

`LINUX_BASH_DESCRIPTION` is written for the model: the existing bash tool runs on
the phone host (Android/Termux, Bionic libc, Termux packages), while `linux_bash`
runs in the Debian/glibc guest with its own `apt`/`dpkg` and the shared glibc
Node.js. This is an execution-environment choice, and the Debian environment is
**not a sandbox**: guest root is a user-space identity, not Android root.

## Known limitations

* host-path passthrough of the shared Node directory relies on the launcher's
  `--host-path`; verification on a real device is still outstanding.
* Android PID/namespace facts (`/proc`) are not virtualized.
* `LD_PRELOAD` reaches only dynamically linked glibc programs; static binaries
  behave differently.
