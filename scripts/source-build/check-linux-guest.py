#!/usr/bin/env python3
"""Check actual guest native bindings before archiving the Linux runtime."""
from pathlib import Path
import sys


def aarch64(path):
    with Path(path).open('rb') as stream:
        header = stream.read(20)
    if len(header) != 20 or header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != 183:
        raise ValueError('guest native binding is not AArch64 ELF: ' + str(path))


def check(engine, home):
    engine, home = Path(engine), Path(home)
    ptys = list(engine.glob('@deepseek-ai/dsh/node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/linux-arm64/pty.node'))
    if len(ptys) != 1:
        raise ValueError('expected one linux-arm64 node-pty binding')
    aarch64(ptys[0])
    aarch64(engine / '@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node')
    canvas = home / '.dsh/profiles/web/node_modules/@napi-rs/canvas-linux-arm64-gnu'
    bindings = list(canvas.glob('*.node'))
    if len(bindings) != 1:
        raise ValueError('expected one glibc Canvas binding')
    aarch64(bindings[0])
    return True


if __name__ == '__main__':
    check(*sys.argv[1:])
    print('Linux guest native bindings verified')
