#!/bin/sh
# Prepare a source-built Debian rootfs for PRoot on Android.
# PRoot virtualizes absolute symlinks; DNS and host paths are bound per command.
set -eu

ROOTFS=""
VERIFY=0
while [ $# -gt 0 ]; do
    case "$1" in
        --rootfs)
            [ $# -ge 2 ] && [ -n "$2" ] || { echo "--rootfs requires a value" >&2; exit 2; }
            ROOTFS="$2"
            shift 2 ;;
        --verify) VERIFY=1; shift ;;
        -h|--help)
            echo "usage: prepare-rootfs.sh --rootfs DIR [--verify]"
            exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$ROOTFS" ] || { echo "--rootfs is required" >&2; exit 2; }
[ -d "$ROOTFS" ] || { echo "not a directory: $ROOTFS" >&2; exit 2; }
ROOTFS="$(cd "$ROOTFS" && pwd -P)"
[ "$ROOTFS" != / ] || { echo "refusing to prepare the host root /" >&2; exit 2; }
ROOTFS="${ROOTFS%/}"

stat_mode() {
    if stat -c %a "$1" >/dev/null 2>&1; then
        stat -c %a "$1"
    else
        # BSD stat's %Lp drops the sticky bit (a 1777 directory is reported as 777).
        # %p includes the file type, so strip the leading directory type before comparing.
        mode=$(stat -f %p "$1")
        case "$mode" in
            4????) mode=${mode#4} ;;
        esac
        printf '%s\n' "$mode"
    fi
}

for directory in dev proc sys tmp var/tmp dev/shm root; do
    if [ "$VERIFY" = 1 ]; then
        [ -d "$ROOTFS/$directory" ] || { echo "NEEDS-FIX /$directory missing" >&2; exit 1; }
    else
        mkdir -p "$ROOTFS/$directory"
    fi
done
if [ "$VERIFY" != 1 ]; then
    mkdir -p "$ROOTFS/etc" "$ROOTFS/opt/pocket-harness"
fi
for directory in tmp var/tmp; do
    if [ "$VERIFY" = 1 ]; then
        [ "$(stat_mode "$ROOTFS/$directory")" = 1777 ] || {
            echo "NEEDS-FIX /$directory must have mode 1777" >&2; exit 1;
        }
    else
        chmod 1777 "$ROOTFS/$directory"
    fi
done

if [ "$VERIFY" = 1 ]; then
    [ -f "$ROOTFS/etc/ld.so.preload" ] && [ ! -L "$ROOTFS/etc/ld.so.preload" ] || {
        echo "NEEDS-FIX /etc/ld.so.preload missing or unsafe" >&2; exit 1;
    }
    [ -s "$ROOTFS/etc/ld.so.preload" ] || { echo "NEEDS-FIX /etc/ld.so.preload empty" >&2; exit 1; }
    [ -f "$ROOTFS/opt/pocket-harness/libpocket-linux-compat.so" ] &&
    [ ! -L "$ROOTFS/opt/pocket-harness/libpocket-linux-compat.so" ] &&
    [ -x "$ROOTFS/opt/pocket-harness/libpocket-linux-compat.so" ] || {
        echo "NEEDS-FIX PRoot compatibility preload missing" >&2; exit 1;
    }
    grep -Fx '/opt/pocket-harness/libpocket-linux-compat.so' "$ROOTFS/etc/ld.so.preload" >/dev/null || {
        echo "NEEDS-FIX /etc/ld.so.preload does not register the compatibility library" >&2; exit 1;
    }
    [ -f "$ROOTFS/etc/resolv.conf" ] && [ ! -L "$ROOTFS/etc/resolv.conf" ] || {
        echo "NEEDS-FIX /etc/resolv.conf missing or unsafe" >&2; exit 1;
    }
else
    printf '%s\n' '/opt/pocket-harness/libpocket-linux-compat.so' > "$ROOTFS/etc/ld.so.preload"
    # DNS is rebound for every command; never preserve a resolver from the build host.
    rm -f "$ROOTFS/etc/resolv.conf"
    printf '%s\n' '# DNS is bound from the current Android network at process start.' > "$ROOTFS/etc/resolv.conf"
fi

echo "PRoot rootfs preparation complete: $ROOTFS"
