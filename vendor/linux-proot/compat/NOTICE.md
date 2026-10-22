# Compatibility preload attribution

`termfold_compat.c` is adapted from `tools/compat-shim/termfold_compat.c` in
[TermFold](https://github.com/Bibarud/TermFold), commit
`a9f678d794a9f9942da923161d6fe996b89b935f`, distributed under Apache-2.0.
The source and license are included in this directory. Pocket Harness builds the
preload into its ARM64 Debian rootfs and registers it in `/etc/ld.so.preload`.

The retained hard-link fallback copies regular files after Android rejects
`link(2)`/`linkat(2)`, then publishes them through a same-directory no-replace
atomic rename; it does not create PRoot's fragile `.l2s` symlink links.
The `/proc/self/fd` `dlopen` fallback is retained for dynamic bundles that pass
an already-open file descriptor to `dlopen`. The shim copies from that descriptor
directly; it does not require exposing host procfs to the guest.
