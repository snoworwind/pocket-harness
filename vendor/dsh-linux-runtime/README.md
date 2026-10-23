# @dsh-android/linux-runtime

The experimental Linux capability plugin installs and runs a Debian/glibc
rootfs through the Termux PRoot binary and owns the Agent-facing `linux_bash`
tool. It is packaged into the APK's ARM64 Termux snapshot by the source-build
workflow. Its inputs are pinned and verified before use; Android device
acceptance is still pending, so this package is not enabled by default.

## Runtime layout and execution

Each install is staged under `<dataDir>/.staging`, then published under
`<dataDir>/instances/<id>`. The active pointer is replaced only after the
backend, rootfs, shared glibc Node.js, compatibility preload and PRoot guest
smoke probe pass. A failed install leaves the previous active instance intact.
The shared Node.js package is content-addressed by its archive SHA-256 and is
removed only when no installed instance references it.

`execute({ command, cwd, timeout, signal })` starts PRoot directly and runs
`/bin/bash -c <command>` inside the selected rootfs. This preserves the
explicit shared Node.js path instead of letting Debian's `/etc/profile`
replace it in a login shell. A guest smoke probe retries at most twice after its
first attempt, and only when PRoot exits 182 with both output streams empty.
Other failures, timeouts, and malformed Node versions fail immediately. This
handles an observed intermittent PRoot loader failure without changing the
normal PRoot syscall translation mode; the exact PRoot source line remains
unconfirmed. Failed install probes persist host/guest cwd, the relevant guest
and PRoot environment, stdout and stderr to the private bootstrap state file,
with each stream bounded to 4096 characters. `execute` returns stdout,
stderr, exit status, signal,
timeout state, cwd, runtime id and architecture. There is no fallback to the
Termux host shell. The Agent sees this through `linux_bash` only after the
runtime health check passes.

On Android, the PRoot launcher, static loader and dependencies are duplicated
from verified Termux packages into APK `nativeLibraryDir`, where Android can
load app native libraries. The same package files are also kept in the runtime
archive for source-side integrity checks and non-Android tests. The APK build
checks ELF shape and then compares each native library and license file in the
APK byte-for-byte with the verified build inputs.

## Security boundary

**PRoot is not a security sandbox.** Its `-0` option presents a guest-side root
identity; it does not grant Android root, mount privileges, capabilities, or
kernel isolation. Guest programs still run as this app's Android UID and remain
subject to the device's SELinux, seccomp, filesystem and `nosuid` policies.
Programs requiring systemd, kernel modules, real mounts, real setuid behavior,
raw sockets or unsupported syscalls may fail.

The guest `/proc` directory is not bound to Android's host procfs. Binding the
full host tree would expose host process metadata and could provide paths such
as `/proc/<pid>/root` into app-private files. Tools that need guest process or
kernel data from `/proc` may therefore be incomplete. PRoot still uses the
host's procfs internally to translate traced file-descriptor operations; this
does not make the host tree visible inside the guest. The runtime also binds
the app's shared-memory directory, current DNS resolver and shared Node.js. A
host working directory is exposed only when it is inside a configured
workspace or shared directory. Symlink targets are canonicalized before the
allowlist check. The runtime does not bind the whole app data directory or
filesystem root.

These restrictions reduce accidental exposure; they do not turn PRoot into a
sandbox. A command running in `linux_bash` can access the guest rootfs and the
explicitly bound directories with the app's Android UID permissions. The user
must confirm Linux installation before activation.

## Android compatibility notes

The rootfs preparation injects the TermFold-derived compatibility preload.
When Android refuses a hard link with `EACCES` or `EPERM`, the preload copies
regular files and recreates symlinks/FIFOs where supported. Regular-file copies
are written to a hidden sibling and published with no-replace atomic rename, so
an interrupted copy never exposes a partial target. A forced process stop can
leave a hidden `.pocket-harness-link-*` temporary file that consumes storage;
each copy is capped at 1 GiB. A copied file is independent: `st_nlink` remains 1,
later writes do not propagate, and duplicate file contents consume additional
storage. This is a compatibility fallback, not hard-link emulation. The
`dlopen("/proc/self/fd/N")` workaround recognizes the descriptor in the traced
process and makes a bounded temporary copy (maximum 1 GiB); it does not require
the guest to see host procfs. It rejects non-regular or changing source files.

PRoot uses ptrace and Termux's `libandroid-shmem`; vendor kernels, SELinux and
seccomp policies can still prevent particular devices or programs from
working. The CI and source checks do not prove Android execution, Debian
package-manager behavior, DNS on every network, or multi-level guest
`execve`. Those remain device acceptance requirements.

## Source and license

The PRoot package closure and Debian rootfs inputs are pinned in
`scripts/source-build/linux-inputs.json` and
`scripts/source-build/linux-backend-packages.json`. Termux's signed `InRelease`
authenticates its ARM64 package index; the builder independently verifies the
index and each `.deb` against that signature before extracting files. Source
archives, package copyright files, local ELF changes, native libraries and APK
payload digests are recorded in the build provenance.

The PRoot executable is GPL-2.0; the closure also includes `libtalloc`
(LGPL-3.0-or-later) and `libandroid-shmem` (BSD-3-Clause). Their package
copyright files and applicable full license texts ship with the APK. The
compatibility preload is adapted from TermFold under Apache-2.0; its source,
upstream attribution, NOTICE and complete license are included in the APK. See
`THIRD_PARTY_NOTICES.md` and `docs/AGENTS/gpl-compliance.md` for the
distribution record.
