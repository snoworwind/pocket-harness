# dsh-shell-linux

`@dsh-android/dsh-shell-linux` supplies the Bash capability inside Pocket Harness's Debian/glibc guest.

It gives each subprocess explicit guest PATH, HOME and SHELL values, reuses the upstream executor's process lifecycle and output limits, and reports the installed toolchain through `probe()`. It does not inject Bionic library paths or emulate a path-level sandbox. Restricted modes fail closed; execution requires the session to explicitly select full access within the Android app UID.

The factory profile config uses `/usr/bin/bash`, `/usr`, `/home` and `/home/.dsh/workspaces`. The plugin exports `LinuxBashExecutor`, `REQUIRED_TOOLCHAIN`, `PROBE_BINARIES` and `TOOLCHAIN_REPRESENTATIVE`.

Source lives in the Pocket Harness repository. CI builds this package before the Linux environment plugin, which imports its shared toolchain table. Generated `lib/` files are not committed.
