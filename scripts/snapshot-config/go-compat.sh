#!/system/bin/sh
set -eu
P="${TERMUX__PREFIX:-@@PREFIX@@}"
exec "$P/bin/node" "$P/share/pocket-harness/go-compat.mjs" "$@"
