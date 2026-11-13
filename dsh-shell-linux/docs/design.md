# Linux guest shell provider

The execution context is the built-in Debian/glibc guest. `LinuxBashExecutor` extends the upstream local executor and preserves its subprocess, timeout and output-budget contracts.

Permission decisions come from the current session's sandbox policy. Environment variables are diagnostic labels, not authorization. Caller-controlled environment values cannot replace the provider's permission labels; restricted modes and an absent explicit full-access selection reject before spawn.

The profile owns deployment paths. Probe results and the model-facing Linux environment view share the exported toolchain constants. Environment preparation is independent of Android host native-library loading, which stays in the PRoot launcher.
