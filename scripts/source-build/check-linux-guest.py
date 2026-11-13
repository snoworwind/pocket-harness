#!/usr/bin/env python3
"""Check actual guest native bindings before archiving the Linux runtime."""
from pathlib import Path
import importlib.util
import sys

SPEC = importlib.util.spec_from_file_location('linux_abi', Path(__file__).with_name('linux-abi.py'))
abi_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(abi_module)


def guest_elf(path, abi):
    config = abi_module.linux_abi(abi)
    with Path(path).open('rb') as stream:
        header = stream.read(20)
    if (len(header) != 20 or header[:6] != b'\x7fELF\x02\x01'
            or int.from_bytes(header[18:20], 'little') != config['elf_machine']):
        raise ValueError(f'guest native binding is not {config["elf_name"]} ELF: {path}')


def check(engine, home, abi='arm64'):
    config = abi_module.linux_abi(abi)
    engine, home = Path(engine), Path(home)
    ptys = list(engine.glob(f'@deepseek-ai/dsh/node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/{config["node_platform"]}/pty.node'))
    if len(ptys) != 1:
        raise ValueError(f'expected one {config["node_platform"]} node-pty binding')
    guest_elf(ptys[0], abi)
    guest_elf(engine / '@deepseek-ai/dsh/node_modules' / config['addon_package'] / 'bin/glibc/system.node', abi)
    canvas = home / '.dsh/profiles/web/node_modules' / config['canvas_binding']
    bindings = list(canvas.glob('*.node'))
    if len(bindings) != 1:
        raise ValueError('expected one glibc Canvas binding')
    guest_elf(bindings[0], abi)
    return True


if __name__ == '__main__':
    check(*sys.argv[1:])
    print('Linux guest native bindings verified')
