# dsh-shell-termux

[🌐 中文说明 / 中文 README](README.zh.md)

> **DeepSeek Harness × Android 生态** · [dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk)（壳 APK）· [dsh-client-ui-responsive](https://github.com/kelai141/dsh-client-ui-responsive)（移动 UI）· [dsh-host-web-compat](https://github.com/kelai141/dsh-host-web-compat)（浏览器兼容）

Android/Termux bash capability provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
Registers as `ctx.shell` on Android so the model's `bash` tool executes in a controlled Termux
environment — no fake sandboxing, no dependency on the ambient environment being accidentally right.

## Why

On Android there is no available path-confined shell backend. This provider supplies the Termux
execution environment and probe diagnostics, then refuses `read-only` and `workspace-write`
commands before spawning bash. Arbitrary shell syntax cannot be safely checked for writes or paths.
`danger-full-access` runs under the Android app UID and remains subject to the app-domain boundary;
it does not mean workspace confinement.

## Quick start

**Prerequisite**: a Termux installation with `bash` (`pkg install bash`).

**1. Install** — put the package into the profile's node_modules (healed fallback resolves its
`@deepseek-ai/*` dependencies to the running dsh instance):

```sh
# from the profile directory (~/.dsh/profiles/web)
npm install /path/to/dsh-shell-termux-0.2.0.tgz
# or manually: unpack into <profile>/node_modules/@dsh-android/dsh-shell-termux/
```

**2. Mount** — add to the profile's `cordis.patch.yml`:

```yaml
- id: bash-sandbox
  disabled: true
- insert:
    - id: shell-termux
      name: '@dsh-android/dsh-shell-termux'
      config:
        bashPath: /data/data/com.termux/files/usr/bin/bash
        prefix: /data/data/com.termux/files/usr
        home: /data/data/com.termux/files/home
        cwd: /data/data/com.termux/files/home
        timeoutMs: 120000
        maxTimeoutMs: 600000
```

**3. Restart** the dsh service and verify with `--dump-config` (the row must be present, not disabled).

## Configuration

| key | meaning | default |
|---|---|---|
| `bashPath` | absolute bash binary path | required |
| `prefix` | Termux prefix root (contains bin/ lib/) | required |
| `home` | Termux home directory | required |
| `termuxVersion` | TERMUX_VERSION value injected | `0.118.3` |
| `extraPath` | extra PATH entries prepended (e.g. /system/bin) | `[]` |
| `cwd` / `timeoutMs` / `maxTimeoutMs` / `maxOutputBytes` / `maxSpillBytes` / `graceMs` | inherited local-executor knobs (editable via shell settings) | mirror `dsh-bash-local` |

## What it does

- **Controlled environment** — every spawn injects `PATH`/`LD_LIBRARY_PATH`/`HOME`/`PREFIX`/`TERMUX_VERSION`/`SHELL`
  explicitly; execution never depends on the launcher environment.
- **Reuses local mechanics** — extends `LocalBashExecutor` (`runArgv`/`startArgv`): process-group
  SIGTERM→SIGKILL, output caps + spill, grace period, background lifecycle, teardown ownership.
- **Fail-closed restricted modes** — `read-only` and `workspace-write` return
  `SANDBOX_UNAVAILABLE` before process creation. `danger-full-access` executes only when selected
  by the session policy; its result reports the Android app-domain boundary as partial enforcement.
- **Diagnostic workspace variables** — `DSH_WORKSPACE` and `DSH_SHARED_DIRS` are passed through for
  child-tool compatibility. They are not access controls and must not be treated as a fence.
- **Probe diagnostics** — `probe()` reports bash presence/version and missing toolchain packages
  (`pkg install bash coreutils findutils grep ripgrep` hints). Misconfigured bash fails loud with
  repair guidance.
- **Single toolchain table** (0.2.0) — `REQUIRED_TOOLCHAIN` / `PROBE_BINARIES` /
  `TOOLCHAIN_REPRESENTATIVE` are exported from one module, so the probe, install hints and any
  consumer list cannot drift apart; a source-level test fails if a second copy of the table exists.

## Verification

- `probe()` status: `full` / `partial` / `unusable` with a missing-package list;
- `npm test` proves both restricted modes are rejected without spawning and the explicit
  `danger-full-access` mode retains its per-call facts;
- fault injection: point `bashPath` at a missing binary → structured error
  (`shell-termux: <path> is not executable; run 'pkg install bash' …`) returned to the model.

## License

MIT. Contains code derived from `@deepseek-ai/dsh-bash-local` (MIT, © 2026 DeepSeek) — see NOTICE.
Design rationale: `docs/design.md`.
